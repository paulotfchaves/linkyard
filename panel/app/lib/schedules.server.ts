import type pg from 'pg'
import { getPool, query, queryOne, transaction } from './db.server.ts'
import { applyBulk, writeLinkChange } from './bulk.server.ts'
import { validateTargetUrl } from './links.ts'
import type { BulkResult, LinkSnapshot } from './bulk.server.ts'

// Scheduled swaps: a change written now and applied later, by whichever process
// gets to it first.
//
// The executor is the part that has to survive reality. It is expected to run
// in more than one process — the edge service runs it on a timer, and an
// operator can run it by hand — so every guard here exists to make a second
// runner harmless rather than to assume there is only one.

/** The columns a schedule may change. `clearTag` removes the tag. */
export type SchedulePatch = {
  targetUrl?: string
  tagId?: string | null
  clearTag?: boolean
  active?: boolean
}

export type ScheduleStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

/** The patch as it is stored: column names, so applying it needs no mapping. */
type StoredPatch = {
  target_url?: string
  tag_id?: string | null
  active?: boolean
}

/** One link's values before the schedule touched it — only the touched ones. */
type PreviousEntry = { id: string } & StoredPatch

export type SchedulePrevious = { links: PreviousEntry[] }

export type ScheduleRow = {
  id: string
  link_ids: string[]
  fire_at: Date
  author_timezone: string
  patch: StoredPatch
  status: ScheduleStatus
  executed_at: Date | null
  previous: SchedulePrevious | null
  note: string | null
  created_by: string | null
  created_at: Date
}

export type ScheduleProblem =
  | 'no_links'
  | 'invalid_fire_at'
  | 'fire_at_in_past'
  | 'invalid_timezone'
  | 'empty_patch'
  | 'conflicting_tag_patch'
  | 'not_pending'
  | 'nothing_to_undo'
  | 'invalid_target_url'

/**
 * Codes, not sentences: the panel is bilingual and owns the wording.
 *
 * `code` is a plain field rather than a constructor parameter property, which
 * Node's type stripping cannot compile away.
 */
export class ScheduleError extends Error {
  readonly code: ScheduleProblem

  constructor(code: ScheduleProblem) {
    super(code)
    this.name = 'ScheduleError'
    this.code = code
  }
}

const PATCH_COLUMNS = ['target_url', 'tag_id', 'active'] as const

function normalizePatch(patch: SchedulePatch): StoredPatch {
  // Setting and clearing the tag in one patch has no defensible reading, and
  // picking one silently would apply the opposite of somebody's intent to every
  // link in the selection.
  if (patch.clearTag && patch.tagId) throw new ScheduleError('conflicting_tag_patch')

  const stored: StoredPatch = {}
  if (patch.targetUrl !== undefined) {
    const target = patch.targetUrl.trim()
    if (target) {
      // The same gate createLink and updateLink apply. A schedule writes to
      // every link in its selection at a moment nobody is watching, so a
      // javascript: destination stored here is worse than one typed into a
      // form, not better.
      const problem = validateTargetUrl(target)
      if (problem) throw new ScheduleError('invalid_target_url')
      stored.target_url = target
    }
  }
  if (patch.clearTag) stored.tag_id = null
  else if (patch.tagId) stored.tag_id = patch.tagId
  if (patch.active !== undefined) stored.active = patch.active

  if (!Object.keys(stored).length) throw new ScheduleError('empty_patch')
  return stored
}

function assertTimezone(timezone: string): string {
  const zone = timezone.trim()
  if (!zone) throw new ScheduleError('invalid_timezone')
  try {
    // fire_at is UTC; this zone only exists so the panel can render the instant
    // back to the person who chose it. A zone no clock can resolve would make
    // that rendering throw at read time, long after the mistake.
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    throw new ScheduleError('invalid_timezone')
  }
  return zone
}

export async function createSchedule(
  input: {
    linkIds: readonly string[]
    fireAt: Date
    authorTimezone: string
    patch: SchedulePatch
    note?: string
  },
  actorId: string | null
): Promise<{ id: string }> {
  const patch = normalizePatch(input.patch)
  const timezone = assertTimezone(input.authorTimezone)

  const fireAt = input.fireAt
  if (!(fireAt instanceof Date) || Number.isNaN(fireAt.getTime())) {
    throw new ScheduleError('invalid_fire_at')
  }
  if (fireAt.getTime() <= Date.now()) throw new ScheduleError('fire_at_in_past')

  const requested = [...new Set(input.linkIds)]
  if (!requested.length) throw new ScheduleError('no_links')

  // Only links that exist and are live are stored. A schedule that names a link
  // deleted before it was even created would fire into nothing later, and the
  // operator would find out then rather than now.
  const live = await query<{ id: string }>(
    'SELECT id FROM links WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
    [requested]
  )
  const linkIds = live.map((row) => row.id)
  if (!linkIds.length) throw new ScheduleError('no_links')

  return transaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO schedules (link_ids, fire_at, author_timezone, patch, note, created_by)
       VALUES ($1::uuid[], $2, $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [linkIds, fireAt, timezone, JSON.stringify(patch), input.note?.trim() || null, actorId]
    )
    const id = created.rows[0].id

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'schedule.create', 'schedule', $2, $3::jsonb)`,
      [actorId, id, JSON.stringify({ link_ids: linkIds, fire_at: fireAt, patch })]
    )
    return { id }
  })
}

export async function listSchedules(
  filter: { status?: ScheduleStatus; linkId?: string } = {}
): Promise<ScheduleRow[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.status) {
    params.push(filter.status)
    where.push(`status = $${params.length}`)
  }
  if (filter.linkId) {
    params.push(filter.linkId)
    where.push(`$${params.length}::uuid = ANY(link_ids)`)
  }

  return query<ScheduleRow>(
    `SELECT * FROM schedules
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY fire_at DESC`,
    params
  )
}

export async function cancelSchedule(id: string, actorId: string | null): Promise<void> {
  await transaction(async (client) => {
    // The status guard is the whole cancellation: a schedule the executor
    // already picked up is no longer pending, so this updates nothing and says
    // so instead of pretending a fired change was called off.
    const cancelled = await client.query(
      `UPDATE schedules SET status = 'cancelled'
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [id]
    )
    if (!cancelled.rowCount) throw new ScheduleError('not_pending')

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id)
       VALUES ($1, 'schedule.cancel', 'schedule', $2)`,
      [actorId, id]
    )
  })
}

const BATCH = 50

type DueRow = { id: string; link_ids: string[]; patch: StoredPatch }

/**
 * Apply every schedule that is due.
 *
 * Three details carry the weight. `FOR UPDATE SKIP LOCKED`, so a second runner
 * passes over what the first is holding instead of applying the same swap
 * twice. A savepoint per schedule, so a failure marks that schedule failed
 * rather than aborting the transaction — without it the very statement
 * recording the failure fails too.
 *
 * And one transaction PER SCHEDULE rather than one for the batch. SKIP LOCKED
 * de-conflicts the `schedules` rows, but says nothing about the `links` rows
 * two disjoint schedules happen to share. Batching 50 into one transaction in
 * fire_at order meant two runners could each hold a link the other wanted and
 * deadlock — and because the loser's error was caught by the savepoint, a
 * transient lock conflict was written down as a terminal 'failed' that nothing
 * ever retries. A schedule that quietly never fires is the worst outcome this
 * module has.
 */

// Postgres classes that mean "try again", not "this will never work".
const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
])

function isRetryable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && RETRYABLE.has((err as { code?: string }).code ?? '')
}
export async function runDueSchedules(pool?: pg.Pool): Promise<{
  applied: number
  failed: number
}> {
  const activePool = pool ?? getPool()
  let applied = 0
  let failed = 0

  // Claim the due set in its own short transaction, then release it. Holding
  // the claim open across the whole batch is what created the cross-runner
  // deadlock.
  const claim = await activePool.connect()
  let due: { rows: DueRow[] }
  try {
    await claim.query('BEGIN')
    due = await claim.query<DueRow>(
      `SELECT id, link_ids, patch
         FROM schedules
        WHERE status = 'pending' AND fire_at <= now()
        ORDER BY fire_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [BATCH]
    )
    await claim.query('COMMIT')
  } catch (err) {
    await claim.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    claim.release()
  }

  for (const row of due.rows) {
    const client = await activePool.connect()
    try {
      await client.query('BEGIN')

      // Re-check under this transaction's own lock: between the claim and here,
      // another runner may have applied or cancelled it.
      const still = await client.query(
        `SELECT id FROM schedules
          WHERE id = $1 AND status = 'pending' AND fire_at <= now()
            FOR UPDATE SKIP LOCKED`,
        [row.id]
      )
      if (!still.rowCount) {
        await client.query('COMMIT')
        continue
      }

      try {
        const previous = await applyScheduleRow(client, row)
        await client.query(
          `UPDATE schedules
              SET status = 'completed', executed_at = now(), previous = $2::jsonb
            WHERE id = $1`,
          [row.id, JSON.stringify({ links: previous })]
        )
        await client.query(
          `INSERT INTO audit_log (action, entity, entity_id, before, after)
           VALUES ('schedule.apply', 'schedule', $1, $2::jsonb, $3::jsonb)`,
          [row.id, JSON.stringify({ links: previous }), JSON.stringify(row.patch)]
        )
        applied += 1
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})

        // A lock conflict is not a broken schedule. Leaving it pending means
        // the next tick picks it up; marking it failed would bury it forever.
        if (isRetryable(err)) {
          failed += 1
          continue
        }

        const reason = err instanceof Error ? err.message : String(err)
        await client.query(
          `UPDATE schedules
              SET status = 'failed', executed_at = now(),
                  note = coalesce(note || ' · ', '') || $2
            WHERE id = $1 AND status = 'pending'`,
          [row.id, reason.slice(0, 300)]
        )
        failed += 1
      }
    } finally {
      client.release()
    }
  }

  return { applied, failed }
}

async function applyScheduleRow(client: pg.PoolClient, row: DueRow): Promise<PreviousEntry[]> {
  // Ordered by id so two runners working on overlapping selections take the row
  // locks in the same order and cannot deadlock. Deleted links are skipped
  // rather than resurrected.
  const links = await client.query<LinkSnapshot>(
    `SELECT * FROM links
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
      ORDER BY id
        FOR UPDATE`,
    [row.link_ids]
  )
  if (!links.rows.length) throw new Error('no_live_links')

  const set: string[] = []
  const values: unknown[] = []
  for (const column of PATCH_COLUMNS) {
    if (!(column in row.patch)) continue
    values.push(row.patch[column])
    set.push(`${column} = $${values.length}`)
  }
  if (!set.length) throw new Error('empty_patch')

  const previous: PreviousEntry[] = []
  for (const before of links.rows) {
    // Only the columns this schedule touches are recorded. A wider snapshot
    // would let an undo drag back a change somebody else made in the meantime
    // to a column the schedule never wrote.
    const entry: PreviousEntry = { id: before.id }
    for (const column of PATCH_COLUMNS) {
      if (column in row.patch) Object.assign(entry, { [column]: before[column] })
    }
    previous.push(entry)

    await writeLinkChange(
      client,
      before,
      set,
      values,
      // A schedule fires with nobody at the keyboard: the actor of record is
      // the schedule itself, and its creator is on the schedule row.
      null,
      'link.schedule_apply',
      'schedule'
    )
  }

  return previous
}

/**
 * Put back what a schedule changed.
 *
 * Undoing twice is allowed and lands on the same values, so no extra state is
 * kept to forbid it. A link deleted since the schedule fired is reported rather
 * than restored.
 */
export async function undoSchedule(id: string, actorId: string | null): Promise<BulkResult> {
  const schedule = await queryOne<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [id])
  if (!schedule || schedule.status !== 'completed' || !schedule.previous) {
    throw new ScheduleError('nothing_to_undo')
  }

  const snapshots = new Map(schedule.previous.links.map((entry) => [entry.id, entry]))

  const result = await applyBulk(
    [...snapshots.keys()],
    actorId,
    'link.schedule_undo',
    (before) => {
      const snapshot = snapshots.get(before.id)
      if (!snapshot) return { reason: 'not_found' }

      const set: string[] = []
      const values: unknown[] = []
      for (const column of PATCH_COLUMNS) {
        if (!(column in snapshot)) continue
        values.push(snapshot[column])
        set.push(`${column} = $${values.length}`)
      }
      if (!set.length) return { skip: true }
      return { set, values }
    },
    { source: 'schedule' }
  )

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
     VALUES ($1, 'schedule.undo', 'schedule', $2, $3::jsonb)`,
    [actorId, id, JSON.stringify({ ok: result.ok, failed: result.failed })]
  )

  return result
}
