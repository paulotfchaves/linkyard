import type pg from 'pg'
import { queryOne, transaction } from './db.server.ts'
import { UTM_KEYS, validateTargetUrl } from './links.ts'
import type { Utms } from './links.ts'

// Bulk editing, destination swaps, and soft delete.
//
// Ported from the panel this product abstracts, where a launch means changing
// three hundred links at once and the two failure modes are known: a batch that
// aborts halfway leaves the campaign in two states, and a batch that writes no
// history leaves nobody able to say what the links used to point at. Every
// operation here therefore records a version and an audit row per link, and one
// link's failure never touches the rest of the batch.

export type BulkResult = {
  ok: number
  failed: number
  errors: Array<{ id: string; reason: string }>
}

/**
 * The reasons a single link can be left out of a batch. They are codes, not
 * sentences: the panel is bilingual, so the wording belongs to the dictionary
 * and only the code crosses this boundary.
 *
 * - `not_found`      no link with that id
 * - `deleted`        the link is in the trash and the operation needs a live one
 * - `not_deleted`    the operation needs a deleted link (restore)
 * - `slug_taken`     its slug was claimed while it was deleted
 * - `tag_not_found`  the tag disappeared between the menu and the click
 * - `empty_patch`    the request asked for no change at all
 * - swap problems, listed on SwapProblem
 */
export type BulkReason =
  | 'not_found'
  | 'deleted'
  | 'not_deleted'
  | 'slug_taken'
  | 'tag_not_found'
  | 'empty_patch'
  | 'forbidden'
  | SwapProblem

// ── swap ────────────────────────────────────────────────────────────────────

export type SwapMode = 'path' | 'replace'

export type SwapParams = {
  mode: SwapMode
  /** The new path in `path` mode, the replacement text in `replace` mode. */
  value: string
  /** The text to look for, `replace` mode only. */
  find?: string
  /** Optional new host, `path` mode only. */
  swapHost?: string | null
}

export type SwapProblem =
  | 'empty_path'
  | 'path_format'
  | 'invalid_url'
  | 'empty_find'
  | 'result_not_url'
  | 'result_scheme'
  | 'host_format'

export type SwapComputation = {
  newTarget: string
  changed: boolean
  error?: SwapProblem
}

/**
 * Split a destination into path, query, and fragment without decoding a byte.
 *
 * The fragment is taken before the query because a '#' ends the query string in
 * the URL grammar. Nothing is re-encoded and nothing is normalised: reattaching
 * base + '?' + query + '#' + hash reproduces the input exactly. Running a
 * destination through `new URL().toString()` instead would collapse dot
 * segments and rewrite escapes, silently changing where a live link points.
 */
export function splitTarget(targetUrl: string): {
  base: string
  query: string | null
  hash: string | null
} {
  let rest = targetUrl
  let hash: string | null = null
  const h = rest.indexOf('#')
  if (h >= 0) {
    hash = rest.slice(h + 1)
    rest = rest.slice(0, h)
  }
  let query: string | null = null
  const q = rest.indexOf('?')
  if (q >= 0) {
    query = rest.slice(q + 1)
    rest = rest.slice(0, q)
  }
  return { base: rest, query, hash }
}

// A new path typed once and applied to hundreds of links is never reviewed per
// link, so anything that would have to be percent-encoded is refused at the
// door rather than encoded on the operator's behalf.
const PATH_CHARS = /^[a-z0-9/-]+$/i

export function normalizePathInput(
  value: string
): { path: string; host?: string } | { error: SwapProblem } {
  const raw = value.trim()
  if (!raw) return { error: 'empty_path' }

  // A full URL is accepted because people paste one: its path is used and its
  // host comes along with it.
  if (/^https?:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { error: 'invalid_url' }
    }
    const stripped = url.pathname.replace(/^\/+|\/+$/g, '')
    if (stripped && !PATH_CHARS.test(stripped)) return { error: 'path_format' }
    return { path: '/' + stripped, host: url.host }
  }

  const stripped = raw.replace(/^\/+|\/+$/g, '')
  if (!stripped) return { path: '/' }
  if (!PATH_CHARS.test(stripped)) return { error: 'path_format' }
  return { path: '/' + stripped }
}

/**
 * The last gate before a computed destination is written to hundreds of links.
 *
 * Three separate ways a swap produced something that parsed but was wrong:
 *
 * 1. `new URL()` alone is not a validator. The WHATWG parser STRIPS tab, CR and
 *    LF before parsing, so a value carrying them parses fine while the string
 *    actually stored still contains them — invisible in the preview the
 *    operator approved, and a response-splitting primitive for any consumer
 *    that writes it into a Location header without re-parsing.
 * 2. `new URL()` happily accepts `javascript://example.com/x`, which is exactly
 *    what validateTargetUrl exists to refuse on the single-link paths. The bulk
 *    path rewrites hundreds at once, so it needs the check more, not less.
 * 3. A swapped host was only trimmed, never parsed, so `not a host` composed a
 *    string that throws at resolve time and 500s every link in the batch.
 */
function guardComputedTarget(value: string): SwapProblem | null {
  if (/[\t\n\r]/.test(value)) return 'result_not_url'
  try {
    new URL(value)
  } catch {
    return 'result_not_url'
  }
  const problem = validateTargetUrl(value)
  if (problem === 'scheme') return 'result_scheme'
  if (problem) return 'result_not_url'
  return null
}

// A host is a host: no scheme, no path, no whitespace, no credentials. Parsing
// it and demanding the parser give the same string back rejects everything else
// without a hand-written character class that will miss a case.
function validSwapHost(host: string): boolean {
  if (!host || /[\s/\\@?#]/.test(host)) return false
  try {
    if (new URL(`https://${host}`).host !== host.toLowerCase()) return false
  } catch {
    return false
  }
  // The parser accepts `..` and `a..b` as hosts, and they compose a URL that
  // parses but can never resolve. Every label must be a real label: non-empty,
  // starting and ending alphanumeric. `localhost` passes, which matters for a
  // VPS install pointing at an internal service.
  return host
    .split('.')
    .every((label) => label.length > 0 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label))
}

export function computeSwap(targetUrl: string, params: SwapParams): SwapComputation {
  if (params.mode === 'replace') {
    const find = params.find ?? ''
    if (!find) return { newTarget: targetUrl, changed: false, error: 'empty_find' }

    // Literal substitution of every occurrence over the raw string. Working on
    // the string rather than a parsed URL is the point: the result keeps the
    // exact escapes the destination arrived with.
    const result = targetUrl.split(find).join(params.value)
    if (result === targetUrl) return { newTarget: targetUrl, changed: false }
    const problem = guardComputedTarget(result)
    if (problem) return { newTarget: targetUrl, changed: false, error: problem }
    return { newTarget: result, changed: true }
  }

  const normalized = normalizePathInput(params.value)
  if ('error' in normalized) return { newTarget: targetUrl, changed: false, error: normalized.error }

  const { base, query, hash } = splitTarget(targetUrl)
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return { newTarget: targetUrl, changed: false, error: 'invalid_url' }
  }

  // Trailing slash is a per-link convention and some destinations 301 without
  // it, so it is read from the original string. `new URL()` cannot answer this:
  // it reports pathname '/' for a bare host either way.
  const trailing = base.endsWith('/')
  let newPath = normalized.path
  if (trailing && !newPath.endsWith('/')) newPath += '/'
  if (newPath === '/' && !trailing) newPath = ''

  const swapHost = params.swapHost?.trim()
  if (swapHost && !validSwapHost(swapHost)) {
    return { newTarget: targetUrl, changed: false, error: 'host_format' }
  }

  const host = swapHost ? swapHost : normalized.host ?? url.host
  const newBase = `${url.protocol}//${host}${newPath}`
  const newTarget = newBase + (query !== null ? '?' + query : '') + (hash !== null ? '#' + hash : '')

  const problem = guardComputedTarget(newTarget)
  if (problem) return { newTarget: targetUrl, changed: false, error: problem }

  return { newTarget, changed: newTarget !== targetUrl }
}

export type SwapPreviewRow = {
  id: string
  slug: string
  before: string
  after: string
  changed: boolean
  error?: SwapProblem
}

/**
 * What a swap would do, computed without touching the database. A bulk change
 * that cannot be read before it is applied is a change nobody dares make.
 */
export function previewSwap(
  links: ReadonlyArray<{ id: string; slug: string; target_url: string }>,
  params: SwapParams
): SwapPreviewRow[] {
  return links.map((link) => {
    const out = computeSwap(link.target_url, params)
    return {
      id: link.id,
      slug: link.slug,
      before: link.target_url,
      after: out.newTarget,
      changed: out.changed,
      ...(out.error ? { error: out.error } : {}),
    }
  })
}

// ── the batch engine ────────────────────────────────────────────────────────

export type LinkSnapshot = {
  id: string
  slug: string
  target_url: string
  tag_id: string | null
  active: boolean
  deleted_at: Date | null
  [column: string]: unknown
}

/** A per-link decision: what to write, nothing to write, or why not. */
export type BulkPlan =
  | { set: string[]; values: unknown[] }
  | { skip: true }
  | { reason: BulkReason }

export type BulkOptions = {
  /** Which side of the trash the operation works on. Defaults to `live`. */
  include?: 'live' | 'deleted'
  /** Recorded on the version row. Defaults to `panel`. */
  source?: 'panel' | 'schedule'
  /**
   * Per-link authorisation, resolved against the link's own domain.
   *
   * Permission in this product is domain-scoped, and a single check at the
   * route would authorise a batch spanning every domain in the installation: a
   * user holding `link:update` scoped to domain D passes the route check and
   * then rewrites destinations in domain E, because nothing between the route
   * and the UPDATE ever reads which domain each id belongs to.
   *
   * Passing this makes the batch a set of individually authorised writes. A
   * link the actor may not touch fails as `forbidden` and the rest proceed —
   * the same shape as every other per-link failure.
   */
  authorize?: (domainId: string) => boolean
}

// A plain field rather than a constructor parameter property: Node strips
// types without transforming them, and a parameter property is a transform.
class BulkFailure extends Error {
  readonly reason: BulkReason

  constructor(reason: BulkReason) {
    super(reason)
    this.reason = reason
  }
}

function reasonFor(err: unknown): string {
  if (err instanceof BulkFailure) return err.reason
  const code = (err as { code?: string }).code
  // links carries exactly one unique index, on (subdomain_id, lower(slug)).
  if (code === '23505') return 'slug_taken'
  return code ?? 'error'
}

function uniqueIds(ids: readonly string[]): string[] {
  // Deduplicated because a selection can carry the same row twice and one
  // change must not become two version rows. Sorted because two batches that
  // lock the same rows in different orders deadlock.
  return [...new Set(ids)].sort()
}

function facts(row: LinkSnapshot) {
  return {
    slug: row.slug,
    target_url: row.target_url,
    tag_id: row.tag_id,
    active: row.active,
    deleted_at: row.deleted_at,
  }
}

/**
 * Apply a plan to every link in the batch.
 *
 * One transaction holds the batch and a savepoint holds each link, so the three
 * writes for a link (row, version, audit) land together or not at all, while a
 * link that fails leaves the rest of the batch committed. This is the shape the
 * reference runner arrived at after a failed row aborted a whole nightly batch:
 * without the savepoint, even the query recording the failure fails.
 */
export async function applyBulk(
  ids: readonly string[],
  actorId: string | null,
  action: string,
  plan: (before: LinkSnapshot) => BulkPlan,
  options: BulkOptions = {}
): Promise<BulkResult> {
  const include = options.include ?? 'live'
  const source = options.source ?? 'panel'
  const targets = uniqueIds(ids)
  const result: BulkResult = { ok: 0, failed: 0, errors: [] }
  if (!targets.length) return result

  await transaction(async (client) => {
    for (const id of targets) {
      await client.query('SAVEPOINT bulk_link')
      try {
        await applyOne(client, id, actorId, action, plan, include, source, options.authorize)
        result.ok += 1
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT bulk_link')
        result.failed += 1
        result.errors.push({ id, reason: reasonFor(err) })
      }
      await client.query('RELEASE SAVEPOINT bulk_link').catch(() => {})
    }
  })

  return result
}

async function applyOne(
  client: pg.PoolClient,
  id: string,
  actorId: string | null,
  action: string,
  plan: (before: LinkSnapshot) => BulkPlan,
  include: 'live' | 'deleted',
  source: 'panel' | 'schedule',
  authorize?: (domainId: string) => boolean
): Promise<void> {
  // FOR UPDATE: the row is read, decided on, and written, and a concurrent
  // editor between the read and the write would have its change overwritten by
  // a decision taken before it existed.
  // The domain comes back in the same locked read, so authorisation cannot be
  // decided from a value that changed after it was checked.
  const found = await client.query<LinkSnapshot & { domain_id: string }>(
    `SELECT l.*, s.domain_id
       FROM links l
       JOIN subdomains s ON s.id = l.subdomain_id
      WHERE l.id = $1
        FOR UPDATE OF l`,
    [id]
  )
  const before = found.rows[0]
  if (!before) throw new BulkFailure('not_found')
  if (authorize && !authorize(before.domain_id)) throw new BulkFailure('forbidden')
  if (include === 'live' && before.deleted_at) throw new BulkFailure('deleted')
  if (include === 'deleted' && !before.deleted_at) throw new BulkFailure('not_deleted')

  const step = plan(before)
  if ('reason' in step) throw new BulkFailure(step.reason)
  if ('skip' in step) return

  await writeLinkChange(client, before, step.set, step.values, actorId, action, source)
}

/**
 * The three writes that make up one link change: the row, its version, and the
 * audit entry. Exported so the schedule executor — which owns its own
 * transaction and its own row locks — records history identically instead of
 * keeping a second, drifting copy of these statements.
 *
 * The caller is responsible for having locked `before`.
 */
export async function writeLinkChange(
  client: pg.PoolClient,
  before: LinkSnapshot,
  set: string[],
  values: unknown[],
  actorId: string | null,
  action: string,
  source: 'panel' | 'schedule'
): Promise<LinkSnapshot> {
  const updated = await client.query<LinkSnapshot>(
    `UPDATE links SET ${set.join(', ')} WHERE id = $${values.length + 1} RETURNING *`,
    [...values, before.id]
  )
  const after = updated.rows[0]

  await client.query(
    `INSERT INTO link_versions (link_id, changed_by, source, before, after)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [before.id, actorId, source, JSON.stringify(before), JSON.stringify(after)]
  )
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
     VALUES ($1, $2, 'link', $3, $4::jsonb, $5::jsonb)`,
    [actorId, action, before.id, JSON.stringify(facts(before)), JSON.stringify(facts(after))]
  )
  return after
}

// ── the operations ──────────────────────────────────────────────────────────

export async function bulkSetActive(
  ids: readonly string[],
  active: boolean,
  actorId: string | null,
  options: BulkOptions = {}
): Promise<BulkResult> {
  return applyBulk(ids, actorId, active ? 'link.activate' : 'link.pause', () => ({
    set: ['active = $1'],
    values: [active],
  }), options)
}

export async function bulkSetTag(
  ids: readonly string[],
  tagId: string | null,
  actorId: string | null,
  options: BulkOptions = {}
): Promise<BulkResult> {
  const targets = uniqueIds(ids)

  // Checked once, before the batch opens. A tag deleted between the menu
  // opening and the click would otherwise surface as a foreign key violation on
  // every single link.
  if (tagId) {
    const tag = await queryOne('SELECT id FROM tags WHERE id = $1', [tagId])
    if (!tag) {
      return {
        ok: 0,
        failed: targets.length,
        errors: targets.map((id) => ({ id, reason: 'tag_not_found' })),
      }
    }
  }

  return applyBulk(
    targets,
    actorId,
    'link.tag',
    () => ({ set: ['tag_id = $1'], values: [tagId] }),
    options
  )
}

/**
 * Write UTM fields across a batch.
 *
 * `merge` touches only the keys the caller named — a null clears that one key.
 * `replace` writes all six, so a key the caller omitted is cleared. The two
 * modes exist because both intents are common and guessing between them from
 * the shape of the object is how a campaign loses its medium.
 */
export async function bulkSetUtms(
  ids: readonly string[],
  utms: Utms,
  mode: 'merge' | 'replace',
  actorId: string | null,
  options: BulkOptions = {}
): Promise<BulkResult> {
  const keys = mode === 'replace' ? [...UTM_KEYS] : UTM_KEYS.filter((key) => key in utms)
  const targets = uniqueIds(ids)

  if (!keys.length) {
    return {
      ok: 0,
      failed: targets.length,
      errors: targets.map((id) => ({ id, reason: 'empty_patch' })),
    }
  }

  const set = keys.map((key, i) => `${key} = $${i + 1}`)
  const values = keys.map((key) => utms[key] ?? null)
  return applyBulk(targets, actorId, 'link.utms', () => ({ set, values }), options)
}

export async function bulkSwapTarget(
  ids: readonly string[],
  params: SwapParams,
  actorId: string | null,
  options: BulkOptions = {}
): Promise<BulkResult> {
  return applyBulk(ids, actorId, 'link.swap', (before) => {
    const out = computeSwap(before.target_url, params)
    if (out.error) return { reason: out.error }
    // A link already pointing at the destination is done, not failed — and
    // recording a version row for a non-change would bury the real ones.
    if (!out.changed) return { skip: true }
    return { set: ['target_url = $1'], values: [out.newTarget] }
  }, options)
}

export async function bulkSoftDelete(
  ids: readonly string[],
  actorId: string | null,
  options: BulkOptions = {}
): Promise<BulkResult> {
  return applyBulk(
    ids,
    actorId,
    'link.delete',
    () => ({ set: ['deleted_at = now()'], values: [] }),
    options
  )
}

export async function bulkRestore(
  ids: readonly string[],
  actorId: string | null,
  options: BulkOptions = {}
): Promise<BulkResult> {
  // The unique index is partial, so a restore can collide with a slug created
  // while this link was in the trash. The savepoint turns that into one entry
  // in errors instead of a failed batch.
  return applyBulk(
    ids,
    actorId,
    'link.restore',
    () => ({ set: ['deleted_at = NULL'], values: [] }),
    { ...options, include: 'deleted' }
  )
}
