import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import worker, { countInstalls, parseInstall, timingSafeEqual } from '../worker/index.js'

const SECRET = 'install-secret-value'

/** A KV double with the behaviour that matters: one key per put, paged listing. */
function kv({ pageSize = 1000 } = {}) {
  const entries = new Map()
  return {
    entries,
    async put(key, value) {
      entries.set(key, value)
    },
    async list({ prefix = '', cursor } = {}) {
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = keys.slice(start, start + pageSize)
      const next = start + page.length
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= keys.length,
        cursor: String(next),
      }
    },
  }
}

const install = (body, headers = {}) =>
  new Request('https://installs.example.dev/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-install-secret': SECRET, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('one authenticated install writes one key and reports the count', async () => {
  const store = kv()
  const env = { INSTALL_SECRET: SECRET, installs: store }

  const response = await worker.fetch(install({ email: 'owner@example.com', locale: 'pt-BR' }), env)
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { installs: 1 })

  const [[key, value]] = [...store.entries]
  assert.match(key, /^install:[0-9a-f-]{36}$/)
  const stored = JSON.parse(value)
  assert.deepEqual(Object.keys(stored).sort(), ['email', 'installed_at', 'locale'])
  assert.equal(stored.email, 'owner@example.com')
  assert.doesNotThrow(() => new Date(stored.installed_at).toISOString())
})

test('concurrent installs each get their own key, so no count is lost', async () => {
  const store = kv()
  const env = { INSTALL_SECRET: SECRET, installs: store }

  const responses = await Promise.all(
    Array.from({ length: 25 }, (_, index) => worker.fetch(install({ email: `owner${index}@example.com` }), env))
  )

  assert.equal(responses.every((response) => response.status === 201), true)
  assert.equal(store.entries.size, 25)
  assert.equal(await countInstalls(store), 25)
})

test('the count is derived by listing, across pages', async () => {
  const store = kv({ pageSize: 7 })
  for (let index = 0; index < 30; index += 1) await store.put(`install:${index}`, '{}')
  await store.put('unrelated', '{}')

  assert.equal(await countInstalls(store), 30)
})

test('the shared secret is compared without leaking how much of it matched', async () => {
  assert.equal(await timingSafeEqual(SECRET, SECRET), true)
  // Same length, wrong content — the case a length check would wave through.
  assert.equal(await timingSafeEqual('install-secret-valuX', SECRET), false)
  assert.equal(await timingSafeEqual('install-secret-value-and-more', SECRET), false)
  assert.equal(await timingSafeEqual(null, SECRET), false)
})

test('a wrong or missing secret is 401, and writes nothing', async () => {
  const store = kv()
  const env = { INSTALL_SECRET: SECRET, installs: store }

  const wrong = await worker.fetch(install({ email: 'a@example.com' }, { 'x-install-secret': 'nope' }), env)
  assert.equal(wrong.status, 401)

  const missing = await worker.fetch(
    new Request('https://installs.example.dev/install', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com' }),
    }),
    env
  )
  assert.equal(missing.status, 401)
  assert.equal(store.entries.size, 0)
})

test('every other path and method is 404, including GET on the same path', async () => {
  const env = { INSTALL_SECRET: SECRET, installs: kv() }
  const cases = [
    new Request('https://installs.example.dev/install', { headers: { 'x-install-secret': SECRET } }),
    new Request('https://installs.example.dev/', { method: 'POST', headers: { 'x-install-secret': SECRET } }),
    new Request('https://installs.example.dev/key?addr=someone@example.com'),
    new Request('https://installs.example.dev/install/', { method: 'POST', headers: { 'x-install-secret': SECRET } }),
  ]

  for (const request of cases) {
    const response = await worker.fetch(request, env)
    assert.equal(response.status, 404, `${request.method} ${request.url} should be 404`)
  }
})

test('a Worker deployed without its secret answers 404 rather than accepting anything', async () => {
  const response = await worker.fetch(install({ email: 'a@example.com' }), { installs: kv() })
  assert.equal(response.status, 404)
})

test('the body is capped, by declaration and by measurement', async () => {
  const env = { INSTALL_SECRET: SECRET, installs: kv() }

  const declared = await worker.fetch(
    install({ email: 'a@example.com' }, { 'content-length': '9999' }),
    env
  )
  assert.equal(declared.status, 413)

  const actual = await worker.fetch(install({ email: 'a@example.com', locale: 'x'.repeat(2000) }), env)
  assert.equal(actual.status, 413)
})

test('the schema is closed: an unknown field is a refusal, not something to ignore', () => {
  assert.deepEqual(parseInstall(JSON.stringify({ email: 'owner@example.com' })), { email: 'owner@example.com', locale: 'en' })
  assert.equal(parseInstall(JSON.stringify({ email: 'owner@example.com', token: 'secret' })), null)
  assert.equal(parseInstall(JSON.stringify({ email: 'owner@example.com', domain: 'example.com' })), null)
  assert.equal(parseInstall(JSON.stringify({ email: 'not-an-email' })), null)
  assert.equal(parseInstall(JSON.stringify({ email: 'owner@example.com', locale: 'fr' })), null)
  assert.equal(parseInstall(JSON.stringify([{ email: 'owner@example.com' }])), null)
  assert.equal(parseInstall('not json'), null)
  assert.equal(parseInstall(''), null)
})

test('a payload the schema refuses is 400 and writes nothing', async () => {
  const store = kv()
  const response = await worker.fetch(install({ email: 'owner@example.com', railwayToken: 'x' }), {
    INSTALL_SECRET: SECRET,
    installs: store,
  })
  assert.equal(response.status, 400)
  assert.equal(store.entries.size, 0)
})

test('there is no email handler and no catch-all to feed one', async () => {
  assert.equal('email' in worker, false)

  const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8')
  assert.equal(/async\s+email\s*\(/.test(source), false)
  assert.equal(/\bemail\s*\(\s*message/.test(source), false)

  // Comments are stripped first: this file explains at length why the email
  // handler is absent, and the words in that explanation are not configuration.
  const config = (await readFile(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/"send_email"/.test(config), false)
  assert.equal(/"email"/.test(config), false)

  const parsed = JSON.parse(config)
  assert.equal(parsed.kv_namespaces[0].binding, 'installs')
  assert.equal(parsed.routes[0].custom_domain, true)
  assert.equal(parsed.main, 'index.js')
})
