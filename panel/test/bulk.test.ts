import assert from 'node:assert/strict'
import { after, before, describe, it, test } from 'node:test'
import {
  bulkRestore,
  bulkSetActive,
  bulkSetTag,
  bulkSetUtms,
  bulkSoftDelete,
  bulkSwapTarget,
  computeSwap,
  previewSwap,
  splitTarget,
} from '../app/lib/bulk.server.ts'
import { createLink, getLink, listLinks } from '../app/lib/links.server.ts'
import { closePool } from '../app/lib/db.server.ts'

// The shared database helpers live in a sibling workspace of plain ESM
// JavaScript that this tsconfig does not cover, so a literal specifier would
// fail `tsc --noEmit` while working perfectly at runtime. Resolving through a
// URL keeps the typecheck honest without a stub declaration file.
const { freshDatabase, TEST_URL } = await import(
  new URL('../../db/test-support/helpers.mjs', import.meta.url).href
)
const { migrate } = await import(new URL('../../db/migrate.mjs', import.meta.url).href)

const SCHEMA = 'bulk_actions_test'
const MISSING_ID = '00000000-0000-0000-0000-0000000000ff'

let db: {
  pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }
  end: () => Promise<void>
}

let actorId: string
let subdomainId: string
let tagId: string
let otherTagId: string

let slugCounter = 0
function nextSlug(prefix: string): string {
  slugCounter += 1
  return `${prefix}-${slugCounter}`
}

async function seedLink(targetUrl = 'https://example.com/landing', slugPrefix = 'link') {
  return createLink({ subdomainId, slug: nextSlug(slugPrefix), targetUrl }, actorId)
}

async function countVersions(linkId: string): Promise<number> {
  const { rows } = await db.pool.query(
    'SELECT count(*)::int AS n FROM link_versions WHERE link_id = $1',
    [linkId]
  )
  return rows[0].n
}

async function countAudit(linkId: string): Promise<number> {
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'link' AND entity_id = $1`,
    [linkId]
  )
  return rows[0].n
}

async function rawLink(linkId: string) {
  const { rows } = await db.pool.query('SELECT * FROM links WHERE id = $1', [linkId])
  return rows[0]
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

  const tags = await db.pool.query(
    `INSERT INTO tags (name) VALUES ('spring'), ('winter') RETURNING id, name`
  )
  tagId = tags.rows.find((t: { name: string }) => t.name === 'spring').id
  otherTagId = tags.rows.find((t: { name: string }) => t.name === 'winter').id
})

after(async () => {
  await closePool()
  await db.end()
})

describe('soft delete', () => {
  it('frees the slug it was holding', async () => {
    const slug = nextSlug('reusable')
    const first = await createLink(
      { subdomainId, slug, targetUrl: 'https://example.com/one' },
      actorId
    )
    await bulkSoftDelete([first.id], actorId)

    const second = await createLink(
      { subdomainId, slug, targetUrl: 'https://example.com/two' },
      actorId
    )
    assert.notEqual(second.id, first.id, 'the reuse is a new link, not a resurrection')

    // The deleted row is still there with its history intact — that is the
    // difference between soft delete and DELETE.
    const old = await rawLink(first.id)
    assert.equal(old.slug, slug)
    assert.ok(old.deleted_at instanceof Date)
  })

  it('does not let a live slug be taken twice', async () => {
    const slug = nextSlug('taken')
    await createLink({ subdomainId, slug, targetUrl: 'https://example.com/one' }, actorId)
    await assert.rejects(
      () => createLink({ subdomainId, slug, targetUrl: 'https://example.com/two' }, actorId),
      (err: { code?: string }) => err.code === '23505'
    )
  })

  it('removes the link from listLinks and from getLink', async () => {
    const link = await seedLink('https://example.com/hidden', 'hidden')

    const visible = await listLinks({ search: link.slug })
    assert.equal(visible.rows.length, 1)
    assert.equal(visible.total, 1)

    await bulkSoftDelete([link.id], actorId)

    const afterDelete = await listLinks({ search: link.slug })
    assert.equal(afterDelete.rows.length, 0, 'a deleted link is not listed')
    assert.equal(afterDelete.total, 0, 'and it is not counted either')
    assert.equal(await getLink(link.id), null, 'and it cannot be fetched by id')
  })

  it('reports a second delete instead of writing history twice', async () => {
    const link = await seedLink('https://example.com/twice', 'twice')
    await bulkSoftDelete([link.id], actorId)
    const versions = await countVersions(link.id)

    const result = await bulkSoftDelete([link.id], actorId)
    assert.deepEqual(result, {
      ok: 0,
      failed: 1,
      errors: [{ id: link.id, reason: 'deleted' }],
    })
    assert.equal(await countVersions(link.id), versions, 'no version row for a non-event')
  })

  it('refuses to edit a deleted link', async () => {
    const link = await seedLink('https://example.com/gone', 'gone')
    await bulkSoftDelete([link.id], actorId)

    const result = await bulkSetActive([link.id], false, actorId)
    assert.equal(result.ok, 0)
    assert.deepEqual(result.errors, [{ id: link.id, reason: 'deleted' }])
  })
})

describe('restore', () => {
  it('brings the link back into the listing', async () => {
    const link = await seedLink('https://example.com/back', 'back')
    await bulkSoftDelete([link.id], actorId)

    const result = await bulkRestore([link.id], actorId)
    assert.equal(result.ok, 1)
    assert.equal(result.failed, 0)

    const listed = await listLinks({ search: link.slug })
    assert.equal(listed.rows.length, 1)
    assert.equal(listed.rows[0].id, link.id)
  })

  it('fails when the slug was taken while the link was away', async () => {
    const slug = nextSlug('contested')
    const original = await createLink(
      { subdomainId, slug, targetUrl: 'https://example.com/original' },
      actorId
    )
    const bystander = await seedLink('https://example.com/bystander', 'bystander')
    await bulkSoftDelete([original.id, bystander.id], actorId)

    // Somebody reused the freed slug in the meantime, which is exactly what the
    // partial unique index allows.
    await createLink({ subdomainId, slug, targetUrl: 'https://example.com/squatter' }, actorId)

    const result = await bulkRestore([original.id, bystander.id], actorId)
    assert.equal(result.ok, 1, 'the bystander still comes back')
    assert.equal(result.failed, 1)
    assert.deepEqual(result.errors, [{ id: original.id, reason: 'slug_taken' }])
    assert.ok((await rawLink(original.id)).deleted_at, 'the contested link stays deleted')
    assert.equal((await rawLink(bystander.id)).deleted_at, null)
  })

  it('refuses a link that was never deleted', async () => {
    const link = await seedLink('https://example.com/live', 'live')
    const result = await bulkRestore([link.id], actorId)
    assert.deepEqual(result.errors, [{ id: link.id, reason: 'not_deleted' }])
  })
})

describe('bulk bookkeeping', () => {
  it('writes exactly one version and one audit row per link', async () => {
    const a = await seedLink('https://example.com/a', 'book')
    const b = await seedLink('https://example.com/b', 'book')
    const beforeVersions = [await countVersions(a.id), await countVersions(b.id)]
    const beforeAudit = [await countAudit(a.id), await countAudit(b.id)]

    const result = await bulkSetActive([a.id, b.id], false, actorId)
    assert.equal(result.ok, 2)

    assert.equal(await countVersions(a.id), beforeVersions[0] + 1)
    assert.equal(await countVersions(b.id), beforeVersions[1] + 1)
    assert.equal(await countAudit(a.id), beforeAudit[0] + 1)
    assert.equal(await countAudit(b.id), beforeAudit[1] + 1)
  })

  it('records the before and the after in the version row', async () => {
    const link = await seedLink('https://example.com/history', 'history')
    await bulkSetActive([link.id], false, actorId)

    const { rows } = await db.pool.query(
      `SELECT before, after, source, changed_by FROM link_versions
        WHERE link_id = $1 ORDER BY changed_at DESC LIMIT 1`,
      [link.id]
    )
    assert.equal(rows[0].source, 'panel')
    assert.equal(rows[0].changed_by, actorId)
    assert.equal(rows[0].before.active, true)
    assert.equal(rows[0].after.active, false)
  })

  it('keeps the good links when one in the batch fails', async () => {
    const a = await seedLink('https://example.com/good-1', 'partial')
    const b = await seedLink('https://example.com/good-2', 'partial')

    const result = await bulkSetActive([a.id, MISSING_ID, b.id], false, actorId)
    assert.equal(result.ok, 2, 'the two real links were still updated')
    assert.equal(result.failed, 1)
    assert.deepEqual(result.errors, [{ id: MISSING_ID, reason: 'not_found' }])

    assert.equal((await rawLink(a.id)).active, false)
    assert.equal((await rawLink(b.id)).active, false)
  })

  it('applies a repeated id once', async () => {
    const link = await seedLink('https://example.com/dup', 'dup')
    const versions = await countVersions(link.id)

    const result = await bulkSetActive([link.id, link.id, link.id], false, actorId)
    assert.equal(result.ok, 1, 'a selection carrying the same row three times is one change')
    assert.equal(await countVersions(link.id), versions + 1)
  })

  it('does nothing at all for an empty selection', async () => {
    assert.deepEqual(await bulkSetActive([], false, actorId), { ok: 0, failed: 0, errors: [] })
  })
})

describe('bulk tag', () => {
  it('applies and clears a tag', async () => {
    const link = await seedLink('https://example.com/tagged', 'tagged')

    assert.equal((await bulkSetTag([link.id], tagId, actorId)).ok, 1)
    assert.equal((await rawLink(link.id)).tag_id, tagId)

    assert.equal((await bulkSetTag([link.id], null, actorId)).ok, 1)
    assert.equal((await rawLink(link.id)).tag_id, null)
  })

  it('moves a link from one tag to another', async () => {
    const link = await seedLink('https://example.com/moved', 'moved')
    await bulkSetTag([link.id], tagId, actorId)
    await bulkSetTag([link.id], otherTagId, actorId)
    assert.equal((await rawLink(link.id)).tag_id, otherTagId)
  })

  it('touches nothing when the tag no longer exists', async () => {
    const link = await seedLink('https://example.com/orphan', 'orphan')
    const versions = await countVersions(link.id)

    const result = await bulkSetTag([link.id], MISSING_ID, actorId)
    assert.equal(result.ok, 0)
    assert.deepEqual(result.errors, [{ id: link.id, reason: 'tag_not_found' }])
    assert.equal(await countVersions(link.id), versions, 'the batch never started')
  })
})

describe('bulk UTMs', () => {
  it('merge writes only the keys it names', async () => {
    const link = await seedLink('https://example.com/utm-merge', 'utm')
    await bulkSetUtms(
      [link.id],
      { utm_source: 'youtube', utm_medium: 'shorts' },
      'replace',
      actorId
    )

    const result = await bulkSetUtms([link.id], { utm_source: 'instagram' }, 'merge', actorId)
    assert.equal(result.ok, 1)

    const row = await rawLink(link.id)
    assert.equal(row.utm_source, 'instagram')
    assert.equal(row.utm_medium, 'shorts', 'a key the patch never named is untouched')
  })

  it('merge clears a key that is named with null', async () => {
    const link = await seedLink('https://example.com/utm-null', 'utm')
    await bulkSetUtms([link.id], { utm_source: 'youtube' }, 'replace', actorId)

    await bulkSetUtms([link.id], { utm_source: null }, 'merge', actorId)
    assert.equal((await rawLink(link.id)).utm_source, null)
  })

  it('replace clears every key it omits', async () => {
    const link = await seedLink('https://example.com/utm-replace', 'utm')
    await bulkSetUtms(
      [link.id],
      { utm_source: 'youtube', utm_medium: 'shorts', utm_campaign: 'launch' },
      'replace',
      actorId
    )

    await bulkSetUtms([link.id], { utm_source: 'newsletter' }, 'replace', actorId)
    const row = await rawLink(link.id)
    assert.equal(row.utm_source, 'newsletter')
    assert.equal(row.utm_medium, null, 'replace means replace')
    assert.equal(row.utm_campaign, null)
  })

  it('refuses an empty merge instead of writing a no-op version row', async () => {
    const link = await seedLink('https://example.com/utm-empty', 'utm')
    const result = await bulkSetUtms([link.id], {}, 'merge', actorId)
    assert.deepEqual(result.errors, [{ id: link.id, reason: 'empty_patch' }])
  })
})

describe('swap computation', () => {
  it('splits a URL without re-encoding it', () => {
    const raw = 'https://shop.example.com/a/../b?q=1%2B2&r=x%20y#z%2Fw'
    const parts = splitTarget(raw)
    assert.equal(parts.base, 'https://shop.example.com/a/../b')
    assert.equal(parts.query, 'q=1%2B2&r=x%20y')
    assert.equal(parts.hash, 'z%2Fw')
    assert.equal(
      parts.base + '?' + parts.query + '#' + parts.hash,
      raw,
      'the split must be reversible byte for byte'
    )
  })

  it('reads the fragment before the query, as the URL spec does', () => {
    // A '#' ends the query, so '?' inside a fragment is part of the fragment.
    const parts = splitTarget('https://example.com/p#frag?not=query')
    assert.equal(parts.hash, 'frag?not=query')
    assert.equal(parts.query, null)
  })

  it('path mode keeps the query string and the fragment', () => {
    const out = computeSwap('https://shop.example.com/old?utm_source=ig&x=1#anchor', {
      mode: 'path',
      value: '/new/landing',
    })
    assert.equal(out.newTarget, 'https://shop.example.com/new/landing?utm_source=ig&x=1#anchor')
    assert.equal(out.changed, true)
  })

  it('path mode honours each link own trailing slash', () => {
    const withSlash = computeSwap('https://shop.example.com/old/', { mode: 'path', value: 'new' })
    assert.equal(withSlash.newTarget, 'https://shop.example.com/new/')

    const without = computeSwap('https://shop.example.com/old', { mode: 'path', value: 'new' })
    assert.equal(without.newTarget, 'https://shop.example.com/new')
  })

  it('path mode can move the host at the same time', () => {
    const out = computeSwap('https://shop.example.com/old?k=v', {
      mode: 'path',
      value: '/new',
      swapHost: 'go.example.net',
    })
    assert.equal(out.newTarget, 'https://go.example.net/new?k=v')
  })

  it('path mode takes the host from a pasted full URL', () => {
    // People paste the whole destination rather than typing a path. Reading the
    // host out of it is the only way that paste means what it looks like.
    const out = computeSwap('https://shop.example.com/old?k=v#f', {
      mode: 'path',
      value: 'https://go.example.net/new',
    })
    assert.equal(out.newTarget, 'https://go.example.net/new?k=v#f')
  })

  it('an explicit host wins over the one in a pasted URL', () => {
    const out = computeSwap('https://shop.example.com/old', {
      mode: 'path',
      value: 'https://go.example.net/new',
      swapHost: 'links.example.org',
    })
    assert.equal(out.newTarget, 'https://links.example.org/new')
  })

  it('path mode rejects input that would need encoding', () => {
    assert.equal(computeSwap('https://example.com/x', { mode: 'path', value: '' }).error, 'empty_path')
    assert.equal(
      computeSwap('https://example.com/x', { mode: 'path', value: '/a b' }).error,
      'path_format'
    )
  })

  it('replace mode re-encodes nothing', () => {
    const before = 'https://shop.example.com/a/../b?q=1%2B2&r=x%20y#z%2Fw'
    // Proof the property has teeth: a round trip through URL rewrites this.
    assert.notEqual(new URL(before).toString(), before)

    const out = computeSwap(before, {
      mode: 'replace',
      find: 'shop.example.com',
      value: 'go.example.net',
    })
    assert.equal(out.newTarget, 'https://go.example.net/a/../b?q=1%2B2&r=x%20y#z%2Fw')
    assert.equal(out.changed, true)
  })

  it('replace mode substitutes every occurrence', () => {
    const out = computeSwap('https://example.com/promo?ref=promo', {
      mode: 'replace',
      find: 'promo',
      value: 'sale',
    })
    assert.equal(out.newTarget, 'https://example.com/sale?ref=sale')
  })

  it('replace mode refuses a substitution that stops being a URL', () => {
    const out = computeSwap('https://example.com/x', {
      mode: 'replace',
      find: 'https://',
      value: '',
    })
    assert.equal(out.error, 'result_not_url')
    assert.equal(out.changed, false)
    assert.equal(out.newTarget, 'https://example.com/x', 'the original survives a refusal')
  })

  it('reports no change when the text is not there', () => {
    const out = computeSwap('https://example.com/x', {
      mode: 'replace',
      find: 'absent',
      value: 'y',
    })
    assert.equal(out.changed, false)
    assert.equal(out.error, undefined)
  })
})

describe('swap preview and apply', () => {
  it('previews every link without writing anything', async () => {
    const a = await seedLink('https://shop.example.com/old?x=1', 'preview')
    const b = await seedLink('https://shop.example.com/new', 'preview')
    const versions = await countVersions(a.id)

    const preview = previewSwap(
      [
        { id: a.id, slug: a.slug, target_url: a.target_url },
        { id: b.id, slug: b.slug, target_url: b.target_url },
      ],
      { mode: 'path', value: '/new' }
    )

    assert.equal(preview[0].before, 'https://shop.example.com/old?x=1')
    assert.equal(preview[0].after, 'https://shop.example.com/new?x=1')
    assert.equal(preview[0].changed, true)
    assert.equal(preview[1].changed, false, 'this one already points there')
    assert.equal(await countVersions(a.id), versions, 'a preview is not a write')
  })

  it('applies the swap and records it', async () => {
    const a = await seedLink('https://shop.example.com/old?utm_source=ig#top', 'swap')
    const b = await seedLink('https://shop.example.com/other', 'swap')

    const result = await bulkSwapTarget([a.id, b.id], { mode: 'path', value: '/launch' }, actorId)
    assert.equal(result.ok, 2)
    assert.equal(
      (await rawLink(a.id)).target_url,
      'https://shop.example.com/launch?utm_source=ig#top'
    )
    assert.equal((await rawLink(b.id)).target_url, 'https://shop.example.com/launch')
  })

  it('counts an unchanged link as done without inventing history', async () => {
    const link = await seedLink('https://shop.example.com/same', 'nochange')
    const versions = await countVersions(link.id)

    const result = await bulkSwapTarget([link.id], { mode: 'path', value: '/same' }, actorId)
    assert.equal(result.ok, 1, 'nothing to do is not a failure')
    assert.equal(result.failed, 0)
    assert.equal(await countVersions(link.id), versions, 'and it is not history either')
  })

  it('reports the swap problem per link', async () => {
    const link = await seedLink('https://shop.example.com/x', 'badswap')
    const result = await bulkSwapTarget([link.id], { mode: 'replace', find: '', value: 'y' }, actorId)
    assert.deepEqual(result.errors, [{ id: link.id, reason: 'empty_find' }])
  })
})

// ── guards added after an adversarial review ────────────────────────────────
// Each of these produced a value that parsed cleanly and would have been
// written to every link in a batch.

test('a swapped host that is not a host is refused', () => {
  const out = computeSwap('https://shop.example.com/old', {
    mode: 'path',
    value: '/new',
    swapHost: 'not a host at all',
  })
  assert.equal(out.changed, false)
  assert.equal(out.error, 'host_format')
  assert.equal(out.newTarget, 'https://shop.example.com/old', 'the original must survive')
})

test('a swapped host carrying a path or a scheme is refused', () => {
  for (const host of ['example.com/path', 'https://example.com', 'user@example.com', 'a b.com']) {
    const out = computeSwap('https://shop.example.com/x', { mode: 'path', value: '/y', swapHost: host })
    assert.equal(out.error, 'host_format', `${host} must be refused`)
  }
})

test('a legitimate host swap still works', () => {
  const out = computeSwap('https://old.example.com/a?keep=1#frag', {
    mode: 'path',
    value: '/b',
    swapHost: 'new.example.com',
  })
  assert.equal(out.changed, true)
  assert.equal(out.newTarget, 'https://new.example.com/b?keep=1#frag')
})

test('CR and LF are refused even though the URL parser strips them', () => {
  // new URL() silently removes tab, CR and LF before parsing, so the parse
  // succeeds while the stored string still carries them — invisible in the
  // preview, and a response-splitting primitive downstream.
  const out = computeSwap('https://example.com/x', {
    mode: 'replace',
    find: '/x',
    value: '/y\r\nX-Injected: 1',
  })
  assert.equal(out.changed, false)
  assert.equal(out.error, 'result_not_url')
  assert.ok(!out.newTarget.includes('\r'), 'no control character may survive into the result')
})

test('a swap cannot move a destination off http(s)', () => {
  const out = computeSwap('https://example.com/x', {
    mode: 'replace',
    find: 'https',
    value: 'javascript',
  })
  assert.equal(out.changed, false)
  assert.equal(out.error, 'result_scheme')
})

test('a path swap that composes an unparseable URL is refused', () => {
  const out = computeSwap('https://example.com/x', { mode: 'path', value: '/y', swapHost: '..' })
  assert.equal(out.changed, false)
  assert.ok(out.error)
})
