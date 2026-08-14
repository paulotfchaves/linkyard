import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  cancelSchedule,
  createSchedule,
  listSchedules,
  runDueSchedules,
  undoSchedule,
} from '../app/lib/schedules.server.ts'
import { bulkSoftDelete } from '../app/lib/bulk.server.ts'
import { createLink } from '../app/lib/links.server.ts'
import { closePool } from '../app/lib/db.server.ts'

// The shared database helpers live in a sibling workspace of plain ESM
// JavaScript that this tsconfig does not cover, so a literal specifier would
// fail `tsc --noEmit` while working perfectly at runtime. Resolving through a
// URL keeps the typecheck honest without a stub declaration file.
const { freshDatabase, TEST_URL } = await import(
  new URL('../../db/test-support/helpers.mjs', import.meta.url).href
)
const { migrate } = await import(new URL('../../db/migrate.mjs', import.meta.url).href)

const SCHEMA = 'schedules_test'
const HOUR = 3_600_000

let db: {
  pool: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>
    connect: () => Promise<any>
  }
  end: () => Promise<void>
}

let actorId: string
let subdomainId: string
let tagId: string

let slugCounter = 0
async function seedLink(targetUrl = 'https://example.com/landing') {
  slugCounter += 1
  return createLink({ subdomainId, slug: `sched-${slugCounter}`, targetUrl }, actorId)
}

function soon(): Date {
  return new Date(Date.now() + HOUR)
}

// A schedule cannot be created in the past — that guard is itself under test —
// so a test that needs a due schedule backdates it the way a passing hour would.
async function makeDue(scheduleId: string): Promise<void> {
  await db.pool.query(`UPDATE schedules SET fire_at = now() - interval '1 minute' WHERE id = $1`, [
    scheduleId,
  ])
}

async function rawLink(linkId: string) {
  const { rows } = await db.pool.query('SELECT * FROM links WHERE id = $1', [linkId])
  return rows[0]
}

async function rawSchedule(id: string) {
  const { rows } = await db.pool.query('SELECT * FROM schedules WHERE id = $1', [id])
  return rows[0]
}

async function countVersions(linkId: string, source: string): Promise<number> {
  const { rows } = await db.pool.query(
    'SELECT count(*)::int AS n FROM link_versions WHERE link_id = $1 AND source = $2',
    [linkId, source]
  )
  return rows[0].n
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  // db.server builds its own pool from the environment, so the test schema has
  // to reach it through the connection startup parameters rather than a SET.
  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`

  const user = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('editor', 'editor@example.com', 'not-a-real-hash', 'editor')
     RETURNING id`
  )
  actorId = user.rows[0].id

  const domain = await db.pool.query(
    `INSERT INTO domains (apex) VALUES ('example.test') RETURNING id`
  )
  const subdomain = await db.pool.query(
    `INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.example.test') RETURNING id`,
    [domain.rows[0].id]
  )
  subdomainId = subdomain.rows[0].id

  const tag = await db.pool.query(`INSERT INTO tags (name) VALUES ('launch') RETURNING id`)
  tagId = tag.rows[0].id
})

after(async () => {
  await closePool()
  await db.end()
})

describe('creating a schedule', () => {
  it('stores the instant, the human timezone, and the patch', async () => {
    const link = await seedLink()
    const fireAt = soon()
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt,
        authorTimezone: 'America/Sao_Paulo',
        patch: { targetUrl: 'https://example.com/next' },
        note: 'launch day',
      },
      actorId
    )

    const row = await rawSchedule(id)
    assert.equal(row.status, 'pending')
    assert.equal(row.fire_at.getTime(), fireAt.getTime())
    // The zone is kept so the panel can show "14:00 America/Sao_Paulo" back to
    // the person instead of an unexplained UTC instant.
    assert.equal(row.author_timezone, 'America/Sao_Paulo')
    assert.deepEqual(row.link_ids, [link.id])
    assert.deepEqual(row.patch, { target_url: 'https://example.com/next' })
    assert.equal(row.note, 'launch day')
  })

  it('refuses an empty patch', async () => {
    const link = await seedLink()
    await assert.rejects(
      () =>
        createSchedule(
          { linkIds: [link.id], fireAt: soon(), authorTimezone: 'UTC', patch: {} },
          actorId
        ),
      /empty_patch/
    )
  })

  it('refuses a fire time that has already passed', async () => {
    const link = await seedLink()
    await assert.rejects(
      () =>
        createSchedule(
          {
            linkIds: [link.id],
            fireAt: new Date(Date.now() - 60_000),
            authorTimezone: 'UTC',
            patch: { active: false },
          },
          actorId
        ),
      /fire_at_in_past/
    )
  })

  it('refuses a timezone no clock can resolve', async () => {
    const link = await seedLink()
    await assert.rejects(
      () =>
        createSchedule(
          {
            linkIds: [link.id],
            fireAt: soon(),
            authorTimezone: 'Mars/Olympus',
            patch: { active: false },
          },
          actorId
        ),
      /invalid_timezone/
    )
  })

  it('refuses to both set and clear the tag', async () => {
    const link = await seedLink()
    await assert.rejects(
      () =>
        createSchedule(
          {
            linkIds: [link.id],
            fireAt: soon(),
            authorTimezone: 'UTC',
            patch: { tagId, clearTag: true },
          },
          actorId
        ),
      /conflicting_tag_patch/
    )
  })

  it('refuses a selection with no live link in it', async () => {
    const link = await seedLink()
    await bulkSoftDelete([link.id], actorId)
    await assert.rejects(
      () =>
        createSchedule(
          {
            linkIds: [link.id],
            fireAt: soon(),
            authorTimezone: 'UTC',
            patch: { active: false },
          },
          actorId
        ),
      /no_links/
    )
  })
})

describe('listing schedules', () => {
  it('filters by status and by link', async () => {
    const mine = await seedLink()
    const other = await seedLink()
    const created = await createSchedule(
      {
        linkIds: [mine.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { active: false },
      },
      actorId
    )

    const forLink = await listSchedules({ linkId: mine.id })
    assert.equal(forLink.length, 1)
    assert.equal(forLink[0].id, created.id)

    assert.equal((await listSchedules({ linkId: other.id })).length, 0)

    const pending = await listSchedules({ status: 'pending' })
    assert.ok(pending.some((row) => row.id === created.id))
    assert.equal(
      (await listSchedules({ status: 'completed' })).some((row) => row.id === created.id),
      false
    )
  })
})

describe('the executor', () => {
  it('leaves a schedule that is not due yet', async () => {
    const link = await seedLink('https://example.com/before')
    await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )

    await runDueSchedules()
    assert.equal((await rawLink(link.id)).target_url, 'https://example.com/before')
  })

  it('applies the patch to every link and completes', async () => {
    const a = await seedLink('https://example.com/before')
    const b = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [a.id, b.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after', tagId, active: false },
      },
      actorId
    )
    await makeDue(id)

    const result = await runDueSchedules()
    assert.equal(result.applied, 1)
    assert.equal(result.failed, 0)

    for (const link of [a, b]) {
      const row = await rawLink(link.id)
      assert.equal(row.target_url, 'https://example.com/after')
      assert.equal(row.tag_id, tagId)
      assert.equal(row.active, false)
    }

    const schedule = await rawSchedule(id)
    assert.equal(schedule.status, 'completed')
    assert.ok(schedule.executed_at instanceof Date)
  })

  it('writes one version row per link, sourced to the schedule', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    await makeDue(id)
    await runDueSchedules()

    assert.equal(await countVersions(link.id, 'schedule'), 1)
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'schedule' AND entity_id = $1`,
      [id]
    )
    assert.equal(rows[0].n, 2, 'one row for the creation, one for the firing')
  })

  it('fires once even when two runners race', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    await makeDue(id)

    // Two processes on the same database is the normal deployment, not an edge
    // case: FOR UPDATE SKIP LOCKED is what keeps the second one from applying
    // the same swap a second time.
    const [first, second] = await Promise.all([runDueSchedules(), runDueSchedules()])

    assert.equal(first.applied + second.applied, 1, 'exactly one runner did the work')
    assert.equal(first.failed + second.failed, 0)
    assert.equal((await rawLink(link.id)).target_url, 'https://example.com/after')
    assert.equal(await countVersions(link.id, 'schedule'), 1, 'and it was applied once')
  })

  it('walks past a schedule another runner is holding', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    await makeDue(id)

    // The previous test races two runners and relies on them overlapping. This
    // one holds the row lock open by hand, so the skip is not a coincidence:
    // without SKIP LOCKED the call below would block until this transaction
    // ends and the test would hang rather than fail.
    const holder = await db.pool.connect()
    try {
      await holder.query('BEGIN')
      const held = await holder.query(
        `SELECT id FROM schedules
          WHERE status = 'pending' AND fire_at <= now()
            FOR UPDATE SKIP LOCKED`
      )
      assert.ok(
        held.rows.some((row: { id: string }) => row.id === id),
        'the holder must really own the lock for this test to mean anything'
      )

      const blocked = await runDueSchedules()
      assert.equal(blocked.applied, 0, 'the locked schedule was skipped, not waited on')
      assert.equal((await rawLink(link.id)).target_url, 'https://example.com/before')

      await holder.query('ROLLBACK')
    } finally {
      holder.release()
    }

    // Released and still pending, so the next pass picks it up.
    assert.equal((await runDueSchedules()).applied, 1)
    assert.equal((await rawLink(link.id)).target_url, 'https://example.com/after')
  })

  it('never fires a cancelled schedule', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    await cancelSchedule(id, actorId)
    await makeDue(id)

    const result = await runDueSchedules()
    assert.equal(result.applied, 0)
    assert.equal((await rawLink(link.id)).target_url, 'https://example.com/before')
    assert.equal((await rawSchedule(id)).status, 'cancelled')
  })

  it('fails the schedule when nothing is left to patch', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    // The link is deleted between the scheduling and the firing.
    await bulkSoftDelete([link.id], actorId)
    await makeDue(id)

    const result = await runDueSchedules()
    assert.equal(result.applied, 0)
    assert.equal(result.failed, 1)

    const schedule = await rawSchedule(id)
    assert.equal(schedule.status, 'failed')
    assert.match(schedule.note ?? '', /no_live_links/)
  })

  it('applies the live links and skips the deleted one', async () => {
    const live = await seedLink('https://example.com/before')
    const gone = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [live.id, gone.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    await bulkSoftDelete([gone.id], actorId)
    await makeDue(id)

    assert.equal((await runDueSchedules()).applied, 1)
    assert.equal((await rawLink(live.id)).target_url, 'https://example.com/after')
    assert.equal((await rawLink(gone.id)).target_url, 'https://example.com/before')
  })
})

describe('cancelling', () => {
  it('refuses a schedule that is no longer pending', async () => {
    const link = await seedLink()
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { active: false },
      },
      actorId
    )
    await cancelSchedule(id, actorId)
    await assert.rejects(() => cancelSchedule(id, actorId), /not_pending/)
  })
})

describe('undo', () => {
  it('stores the previous values and puts them back', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after', tagId },
      },
      actorId
    )
    await makeDue(id)
    await runDueSchedules()

    const schedule = await rawSchedule(id)
    assert.deepEqual(schedule.previous, {
      links: [{ id: link.id, target_url: 'https://example.com/before', tag_id: null }],
    })

    const result = await undoSchedule(id, actorId)
    assert.equal(result.ok, 1)
    assert.equal(result.failed, 0)

    const restored = await rawLink(link.id)
    assert.equal(restored.target_url, 'https://example.com/before')
    assert.equal(restored.tag_id, null)
  })

  it('records only the fields the schedule touched', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { active: false },
      },
      actorId
    )
    await makeDue(id)
    await runDueSchedules()

    // Undo must not drag a destination change made by a human back with it, so
    // the snapshot holds the patched columns and nothing else.
    assert.deepEqual((await rawSchedule(id)).previous, {
      links: [{ id: link.id, active: true }],
    })
  })

  it('refuses a schedule that never ran', async () => {
    const link = await seedLink()
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { active: false },
      },
      actorId
    )
    await assert.rejects(() => undoSchedule(id, actorId), /nothing_to_undo/)
  })

  it('reports the link it cannot restore', async () => {
    const link = await seedLink('https://example.com/before')
    const { id } = await createSchedule(
      {
        linkIds: [link.id],
        fireAt: soon(),
        authorTimezone: 'UTC',
        patch: { targetUrl: 'https://example.com/after' },
      },
      actorId
    )
    await makeDue(id)
    await runDueSchedules()
    await bulkSoftDelete([link.id], actorId)

    const result = await undoSchedule(id, actorId)
    assert.equal(result.ok, 0)
    assert.deepEqual(result.errors, [{ id: link.id, reason: 'deleted' }])
  })
})
