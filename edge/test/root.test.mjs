import assert from 'node:assert/strict'
import http from 'node:http'
import test, { after, before } from 'node:test'
import { freshDatabase } from '../../db/test-support/helpers.mjs'
import { migrate } from '../../db/migrate.mjs'
import { createEdgeServer, startScheduler } from '../src/server.mjs'
import { createCollector } from '../src/collect.mjs'

const SCHEMA = 'edge_root_test'
const IP = '203.0.113.7'

let db
let server
let port
let collector

/** Drives the real server over a real socket, so the Host header is the one the resolver reads. */
function ask(path, { host = 'go.example.com', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { host, 'x-forwarded-for': IP, ...headers } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  const domain = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  const domainId = domain.rows[0].id

  const go = await db.pool.query(
    `INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.example.com') RETURNING id`,
    [domainId]
  )
  await db.pool.query(
    `INSERT INTO subdomains (domain_id, host, root_policy, root_target)
     VALUES ($1, 'shop.example.com', 'custom_url', 'https://example.com/store')`,
    [domainId]
  )
  await db.pool.query(
    `INSERT INTO subdomains (domain_id, host, root_policy) VALUES ($1, 'brand.example.com', 'branded_page')`,
    [domainId]
  )
  // A subdomain that overrides the policy to custom_url and then loses its
  // target. The root still may not 404.
  await db.pool.query(
    `INSERT INTO subdomains (domain_id, host, root_policy) VALUES ($1, 'orphan.example.com', 'custom_url')`,
    [domainId]
  )
  await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url) VALUES ($1, 'promo', 'https://shop.example.com/promo')`,
    [go.rows[0].id]
  )

  collector = createCollector({ pool: db.pool, flushMs: 20, maxBatch: 10 })
  server = createEdgeServer({
    pool: db.pool,
    collector,
    securityContact: 'mailto:security@example.com',
    ipSalt: 'test-salt',
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await collector.stop()
  await new Promise((resolve) => server.close(resolve))
  await db.end()
})

test('a redirect is a 302 that no browser may cache', async () => {
  const res = await ask('/promo')
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://shop.example.com/promo')
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('every response carries the hygiene headers and no X-Powered-By', async () => {
  for (const path of ['/promo', '/', '/robots.txt', '/favicon.ico', '/nope', '/healthz']) {
    const res = await ask(path)
    assert.equal(res.headers['referrer-policy'], 'no-referrer', path)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path)
    assert.equal(res.headers['x-powered-by'], undefined, path)
  }
})

test('the root under redirect_apex sends the visitor to the apex', async () => {
  const res = await ask('/')
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://example.com/')
})

test('the root under custom_url sends the visitor to the configured target', async () => {
  const res = await ask('/', { host: 'shop.example.com' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://example.com/store')
})

test('the root under branded_page serves a page that names the domain', async () => {
  const res = await ask('/', { host: 'brand.example.com' })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /brand\.example\.com/)
  // Self-contained: a redirect domain that pulls a font or a script from
  // somewhere else hands a third party the traffic log it exists to keep.
  assert.doesNotMatch(res.body, /https?:\/\/(?!example\.com)/)
})

// The root answering 404 is what makes a redirect domain look disposable to
// WhatsApp and Meta scanners, and being on their blocklist ends the domain.
test('the root never answers 404, under any policy or none', async () => {
  for (const host of ['go.example.com', 'shop.example.com', 'brand.example.com', 'orphan.example.com', 'stranger.example.net']) {
    const res = await ask('/', { host })
    assert.notEqual(res.status, 404, host)
    assert.ok(res.status === 200 || res.status === 302, `${host} answered ${res.status}`)
  }
})

test('robots.txt is served, allows the root and disallows the slug space', async () => {
  const res = await ask('/robots.txt')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/plain/)
  assert.match(res.body, /^Disallow: \/$/m)
  assert.match(res.body, /^Allow: \/\$$/m)
})

test('favicon.ico is served and is never a 404', async () => {
  const res = await ask('/favicon.ico')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /image\//)
  assert.ok(res.body.length > 0)
})

test('security.txt is served with the operator contact', async () => {
  const res = await ask('/.well-known/security.txt')
  assert.equal(res.status, 200)
  assert.match(res.body, /^Contact: mailto:security@example\.com$/m)
  // RFC 9116 makes Expires mandatory; without it the file is invalid and every
  // scanner that reads it says so.
  assert.match(res.body, /^Expires: /m)
})

test('security.txt is omitted rather than served empty when no contact is set', async () => {
  const bare = createEdgeServer({ pool: db.pool, collector, ipSalt: 'test-salt' })
  await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve))
  const barePort = bare.address().port
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: barePort, path: '/.well-known/security.txt', headers: { host: 'go.example.com' } },
      (r) => {
        let body = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (body += c))
        r.on('end', () => resolve({ status: r.statusCode, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(res.status, 404)
  await new Promise((resolve) => bare.close(resolve))
})

test('healthz answers 200 JSON', async () => {
  const res = await ask('/healthz')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(JSON.parse(res.body).status, 'ok')
})

test('an unknown slug gets a branded HTML page, never text/plain', async () => {
  const res = await ask('/does-not-exist')
  assert.equal(res.status, 404)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.doesNotMatch(res.headers['content-type'], /text\/plain/)
  assert.match(res.body, /<html/)
})

// The Host header is written by whoever sends the request. Reflecting it into
// the branded page unescaped turns every redirect domain into a stored-free XSS
// on demand.
test('the Host header is escaped before it reaches the page', async () => {
  const res = await ask('/does-not-exist', { host: 'x<script>alert(1)</script>.example.net' })
  assert.doesNotMatch(res.body, /<script>alert/)
  assert.match(res.body, /&lt;script&gt;/)
})

test('HEAD gets the headers and no body', async () => {
  const res = await ask('/promo', { method: 'HEAD' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://shop.example.com/promo')
  assert.equal(res.body, '')
})

test('a click is recorded after the response, with the bot flag and the referrer host', async () => {
  await ask('/promo', {
    headers: {
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      referer: 'https://www.instagram.com/p/abc',
      'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
    },
  })
  await collector.flush()
  const { rows } = await db.pool.query(
    `SELECT * FROM click_events WHERE referrer_host = 'www.instagram.com' ORDER BY occurred_at DESC LIMIT 1`
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].is_bot, false)
  assert.equal(rows[0].device, 'mobile')
  assert.equal(rows[0].os, 'iOS')
  assert.equal(rows[0].browser, 'Safari')
  assert.equal(rows[0].language, 'pt-BR')
  assert.equal(rows[0].final_url, 'https://shop.example.com/promo')
})

test('a preview fetch is recorded as a bot and still gets its redirect', async () => {
  const res = await ask('/promo', { headers: { 'user-agent': 'WhatsApp/2.23.20.0 A' } })
  assert.equal(res.status, 302)
  await collector.flush()
  const { rows } = await db.pool.query(
    `SELECT is_bot, bot_kind FROM click_events WHERE bot_kind = 'whatsapp' LIMIT 1`
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].is_bot, true)
})

// A raw address is personal data under the LGPD and the product has no use for
// one. The check reads every text column rather than only ip_hash, because the
// leak this guards against is a stray address copied into some other field.
test('a raw IP never reaches the database', async () => {
  await ask('/promo')
  await collector.flush()
  const { rows } = await db.pool.query('SELECT * FROM click_events')
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.ok(Buffer.isBuffer(row.ip_hash))
    assert.equal(row.ip_hash.length, 32)
    assert.equal(row.ip_hash.includes(IP), false)
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'string') assert.equal(value.includes(IP), false, column)
    }
  }
})

// Two visits from one address must land in one bucket or the unique-visitor
// count is just the click count wearing a different label.
test('one address is one bucket, two addresses are two', async () => {
  await ask('/promo', { headers: { 'x-forwarded-for': '198.51.100.4' } })
  await ask('/promo', { headers: { 'x-forwarded-for': '198.51.100.4' } })
  await collector.flush()
  const { rows } = await db.pool.query(
    'SELECT count(DISTINCT ip_hash)::int AS buckets, count(*)::int AS events FROM click_events'
  )
  assert.equal(rows[0].buckets, 2)
  assert.ok(rows[0].events > 2)
})

// The edge is the process that runs continuously, so it is the one that fires
// scheduled swaps. The panel may be asleep, restarting, or scaled to zero.
test('the scheduler runs here and a due swap changes what the redirect answers', async () => {
  const link = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     SELECT id, 'swap', 'https://shop.example.com/old' FROM subdomains WHERE host = 'go.example.com'
     RETURNING id`
  )
  const linkId = link.rows[0].id
  await db.pool.query(
    `INSERT INTO schedules (link_ids, fire_at, author_timezone, patch)
     VALUES (ARRAY[$1]::uuid[], now() - interval '1 minute', 'UTC', $2::jsonb)`,
    [linkId, JSON.stringify({ target_url: 'https://shop.example.com/new' })]
  )

  assert.equal((await ask('/swap')).headers.location, 'https://shop.example.com/old')

  const stop = startScheduler(db.pool, 60_000)
  try {
    const deadline = Date.now() + 5_000
    let location
    do {
      await new Promise((resolve) => setTimeout(resolve, 25))
      location = (await ask('/swap')).headers.location
    } while (location !== 'https://shop.example.com/new' && Date.now() < deadline)
    assert.equal(location, 'https://shop.example.com/new')
  } finally {
    stop()
  }

  const { rows } = await db.pool.query('SELECT status FROM schedules WHERE link_ids @> ARRAY[$1]::uuid[]', [linkId])
  assert.equal(rows[0].status, 'completed')
})

test('a miss with no link recorded is not written as a click', async () => {
  await collector.flush()
  const before = await db.pool.query('SELECT count(*)::int AS n FROM click_events')
  await ask('/nothing-here')
  await ask('/robots.txt')
  await collector.flush()
  const after = await db.pool.query('SELECT count(*)::int AS n FROM click_events')
  assert.equal(after.rows[0].n, before.rows[0].n)
})
