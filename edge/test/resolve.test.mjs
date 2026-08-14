import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { freshDatabase } from '../../db/test-support/helpers.mjs'
import { migrate } from '../../db/migrate.mjs'
import { createHostCache, normalizeHost, resolveRequest } from '../src/resolve.mjs'

const SCHEMA = 'edge_resolve_test'
const HOUR = 3_600_000

let db
let subdomainId
let bareSubdomainId

async function link(subdomain, slug, columns = {}) {
  const { target_url: targetUrl = 'https://shop.example.com/product', ...rest } = columns
  const entries = Object.entries(rest)
  const names = entries.map(([name]) => name)
  const placeholders = entries.map((_, i) => `$${i + 4}`)
  const { rows } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url${names.length ? ', ' + names.join(', ') : ''})
     VALUES ($1, $2, $3${placeholders.length ? ', ' + placeholders.join(', ') : ''})
     RETURNING id`,
    [subdomain, slug, targetUrl, ...entries.map(([, v]) => v)]
  )
  return rows[0].id
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  const domain = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  const withFallback = await db.pool.query(
    `INSERT INTO subdomains (domain_id, host, fallback_url)
     VALUES ($1, 'go.example.com', 'https://example.com/lost') RETURNING id`,
    [domain.rows[0].id]
  )
  subdomainId = withFallback.rows[0].id

  const bare = await db.pool.query(
    `INSERT INTO subdomains (domain_id, host) VALUES ($1, 'bare.example.com') RETURNING id`,
    [domain.rows[0].id]
  )
  bareSubdomainId = bare.rows[0].id
})

after(async () => {
  await db.end()
})

function ask(overrides) {
  return resolveRequest(
    db.pool,
    { host: 'go.example.com', pathname: '/promo', search: '', ...overrides },
    createHostCache()
  )
}

test('normalizeHost lowercases, strips the port and the trailing dot', () => {
  assert.equal(normalizeHost('GO.Example.COM'), 'go.example.com')
  assert.equal(normalizeHost('go.example.com:8080'), 'go.example.com')
  assert.equal(normalizeHost('go.example.com.'), 'go.example.com')
  assert.equal(normalizeHost('  GO.example.com:443  '), 'go.example.com')
  assert.equal(normalizeHost(undefined), '')
})

// The single most important assertion in this repository. A 301 is cached by the
// browser forever, so the next destination swap would never reach anyone who had
// already clicked — which is the one thing the product promises.
test('an active link answers 302, never 301', async () => {
  await link(subdomainId, 'promo', { target_url: 'https://shop.example.com/promo' })
  const out = await ask({ pathname: '/promo' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.status, 302)
  assert.notEqual(out.status, 301)
  assert.equal(out.location, 'https://shop.example.com/promo')
})

test('the destination is composed the way the panel composes it', async () => {
  await link(subdomainId, 'utms', {
    target_url: 'https://shop.example.com/p?ref=house',
    utm_source: 'instagram',
    utm_campaign: 'launch',
    params: JSON.stringify({ aff: '12' }),
  })
  const out = await ask({ pathname: '/utms' })
  const url = new URL(out.location)
  assert.equal(url.searchParams.get('ref'), 'house')
  assert.equal(url.searchParams.get('utm_source'), 'instagram')
  assert.equal(url.searchParams.get('utm_campaign'), 'launch')
  assert.equal(url.searchParams.get('aff'), '12')
})

test('pass_through carries the visitor query string, and only into gaps', async () => {
  await link(subdomainId, 'through', {
    target_url: 'https://shop.example.com/p',
    utm_source: 'stored',
    pass_through: true,
  })
  const out = await ask({ pathname: '/through', search: '?utm_source=arrived&fbclid=xyz' })
  const url = new URL(out.location)
  assert.equal(url.searchParams.get('utm_source'), 'stored')
  assert.equal(url.searchParams.get('fbclid'), 'xyz')
})

test('a link without pass_through ignores the visitor query string', async () => {
  await link(subdomainId, 'closed', { target_url: 'https://shop.example.com/p' })
  const out = await ask({ pathname: '/closed', search: '?fbclid=xyz' })
  assert.equal(new URL(out.location).searchParams.has('fbclid'), false)
})

test('redirect_type on the link overrides the default 302', async () => {
  await link(subdomainId, 'perm', { redirect_type: 302 })
  await link(subdomainId, 'keepmethod', { redirect_type: 307 })
  assert.equal((await ask({ pathname: '/perm' })).status, 302)
  assert.equal((await ask({ pathname: '/keepmethod' })).status, 307)
})

test('slug matching is case-insensitive', async () => {
  await link(subdomainId, 'MixedCase', { target_url: 'https://shop.example.com/mixed' })
  const out = await ask({ pathname: '/mixedcase' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.location, 'https://shop.example.com/mixed')
})

test('a trailing slash resolves the same link', async () => {
  const out = await ask({ pathname: '/promo/' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.location, 'https://shop.example.com/promo')
})

test('an expired link uses its own fallback', async () => {
  await link(subdomainId, 'gone', {
    expires_at: new Date(Date.now() - HOUR),
    fallback_url: 'https://example.com/campaign-over',
  })
  const out = await ask({ pathname: '/gone' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.status, 302)
  assert.equal(out.location, 'https://example.com/campaign-over')
  assert.equal(out.via, 'link_fallback')
})

test('an expired link without its own fallback uses the subdomain fallback', async () => {
  await link(subdomainId, 'stale', { expires_at: new Date(Date.now() - HOUR) })
  const out = await ask({ pathname: '/stale' })
  assert.equal(out.location, 'https://example.com/lost')
  assert.equal(out.via, 'subdomain_fallback')
})

test('an expired link with no fallback anywhere reaches the 404 page', async () => {
  await link(bareSubdomainId, 'stale', { expires_at: new Date(Date.now() - HOUR) })
  const out = await ask({ host: 'bare.example.com', pathname: '/stale' })
  assert.equal(out.type, 'not_found')
  assert.equal(out.reason, 'expired')
})

// Expiry is checked before the active flag: a paused link whose date has also
// passed is expired, and an expired link is the one case with a fallback.
test('an expiry that has passed outranks the active flag', async () => {
  await link(subdomainId, 'both', {
    active: false,
    expires_at: new Date(Date.now() - HOUR),
    fallback_url: 'https://example.com/both',
  })
  const out = await ask({ pathname: '/both' })
  assert.equal(out.location, 'https://example.com/both')
})

test('a paused link reaches the 404 page and never the fallback', async () => {
  await link(subdomainId, 'paused', { active: false })
  const out = await ask({ pathname: '/paused' })
  assert.equal(out.type, 'not_found')
  assert.equal(out.reason, 'inactive')
})

test('an unknown slug uses the subdomain fallback when there is one', async () => {
  const out = await ask({ pathname: '/never-existed' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.status, 302)
  assert.equal(out.location, 'https://example.com/lost')
  assert.equal(out.linkId, null)
})

test('an unknown slug without a subdomain fallback reaches the 404 page', async () => {
  const out = await ask({ host: 'bare.example.com', pathname: '/never-existed' })
  assert.equal(out.type, 'not_found')
  assert.equal(out.reason, 'unknown_slug')
})

test('a soft-deleted link stops resolving', async () => {
  const id = await link(subdomainId, 'deleted', { target_url: 'https://shop.example.com/old' })
  await db.pool.query('UPDATE links SET deleted_at = now() WHERE id = $1', [id])
  const out = await ask({ pathname: '/deleted' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.location, 'https://example.com/lost')
  assert.equal(out.linkId, null)
})

test('an unknown host reaches the 404 page', async () => {
  const out = await ask({ host: 'nobody.example.org', pathname: '/promo' })
  assert.equal(out.type, 'not_found')
  assert.equal(out.reason, 'unknown_host')
})

test('a deactivated subdomain stops resolving links', async () => {
  await db.pool.query(`UPDATE subdomains SET active = false WHERE host = 'bare.example.com'`)
  const out = await ask({ host: 'bare.example.com', pathname: '/stale' })
  assert.equal(out.type, 'not_found')
  assert.equal(out.reason, 'host_inactive')
  await db.pool.query(`UPDATE subdomains SET active = true WHERE host = 'bare.example.com'`)
})

// Validation lives at write time, but a row edited by hand in psql has never
// been through it. A destination that will not parse must degrade to the
// fallback, not throw a 500 at the visitor.
test('a destination that will not parse degrades to the fallback', async () => {
  await link(subdomainId, 'broken', { target_url: 'not a url at all' })
  const out = await ask({ pathname: '/broken' })
  assert.equal(out.type, 'redirect')
  assert.equal(out.location, 'https://example.com/lost')
  assert.equal(out.via, 'subdomain_fallback')
})

test('the host cache serves a second lookup without touching the database', async () => {
  const cache = createHostCache()
  const counting = {
    calls: 0,
    query(...args) {
      counting.calls += 1
      return db.pool.query(...args)
    },
  }
  const request = { host: 'go.example.com', pathname: '/promo', search: '' }
  await resolveRequest(counting, request, cache)
  const afterFirst = counting.calls
  await resolveRequest(counting, request, cache)
  // One query for the host plus one for the link, then only the link query.
  assert.equal(afterFirst, 2)
  assert.equal(counting.calls, 3)
})

test('the host cache expires and re-reads', async () => {
  const cache = createHostCache({ ttlMs: 0 })
  const counting = {
    calls: 0,
    query(...args) {
      counting.calls += 1
      return db.pool.query(...args)
    },
  }
  const request = { host: 'go.example.com', pathname: '/promo', search: '' }
  await resolveRequest(counting, request, cache)
  await resolveRequest(counting, request, cache)
  assert.equal(counting.calls, 4)
})

// A Host header is attacker-controlled and arrives on every request. An
// unbounded map keyed on it is a memory-exhaustion vector reachable by anyone
// who can send traffic to the edge.
test('the host cache is bounded and evicts the oldest entry', () => {
  const cache = createHostCache({ max: 3 })
  for (const host of ['a', 'b', 'c', 'd']) cache.set(host, null)
  assert.equal(cache.size, 3)
  assert.equal(cache.get('a'), undefined)
  assert.notEqual(cache.get('d'), undefined)
})
