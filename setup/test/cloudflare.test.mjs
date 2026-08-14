import test from 'node:test'
import assert from 'node:assert/strict'
import { FAILURE, Secret } from '../src/secret.mjs'
import {
  assertCreatableHost,
  createRecord,
  deleteRecord,
  inspectCredential,
  resolveZone,
  verifyToken,
} from '../src/cloudflare.mjs'

const SENTINEL = 'cf-sentinel-token-never-logged'

function responder(steps) {
  const calls = []
  const queue = [...steps]
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected call to ${url}`)
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    }
  }
  return { fetchImpl, calls }
}

const ok = (result) => ({ body: { success: true, result } })

test('the token is revealed only in the Authorization header', async () => {
  const { fetchImpl, calls } = responder([ok({ id: 'tok', status: 'active' })])
  await verifyToken(new Secret(SENTINEL), { fetchImpl })
  assert.equal(calls[0].headers.authorization, `Bearer ${SENTINEL}`)
})

test('a rejected token is a token failure, not a generic API failure', async () => {
  const { fetchImpl } = responder([{ status: 403, body: { success: false, errors: [{ message: SENTINEL }] } }])
  await assert.rejects(
    () => verifyToken(new Secret(SENTINEL), { fetchImpl }),
    (error) => {
      assert.equal(error.code, FAILURE.CLOUDFLARE_TOKEN_INVALID)
      assert.equal(error.message.includes(SENTINEL), false)
      return true
    }
  )
})

test('a token that can see more than one zone is refused as unscoped', async () => {
  const { fetchImpl } = responder([ok([{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'other.com' }])])
  await assert.rejects(
    () => resolveZone(new Secret(SENTINEL), 'example.com', { fetchImpl }),
    (error) => error.code === FAILURE.CLOUDFLARE_TOKEN_UNSCOPED
  )
})

test('a token scoped to the wrong zone is named as such', async () => {
  const { fetchImpl } = responder([ok([{ id: 'z2', name: 'other.com' }])])
  await assert.rejects(
    () => resolveZone(new Secret(SENTINEL), 'example.com', { fetchImpl }),
    (error) => error.code === FAILURE.CLOUDFLARE_ZONE_NOT_FOUND
  )
})

test('a readable token with no expiry is refused, an unreadable one is not', async () => {
  const forever = responder([
    ok({ id: 'tok', status: 'active' }),
    ok([{ id: 'z1', name: 'example.com' }]),
    ok({ id: 'tok', expires_on: null }),
  ])
  await assert.rejects(
    () => inspectCredential(new Secret(SENTINEL), 'example.com', { fetchImpl: forever.fetchImpl }),
    (error) => error.code === FAILURE.CLOUDFLARE_TOKEN_NO_TTL
  )

  // Reading the token's own record needs a permission the provision does not,
  // so "cannot read" must not become "refuse".
  const unreadable = responder([
    ok({ id: 'tok', status: 'active' }),
    ok([{ id: 'z1', name: 'example.com' }]),
    { status: 403, body: { success: false } },
  ])
  const resolved = await inspectCredential(new Secret(SENTINEL), 'example.com', { fetchImpl: unreadable.fetchImpl })
  assert.deepEqual(resolved, { zoneId: 'z1', zoneName: 'example.com', expiresOn: null })
})

test('the apex and www are never writable', () => {
  for (const host of ['example.com', 'www.example.com', 'links.other.com', '']) {
    assert.throws(
      () => assertCreatableHost('example.com', host),
      (error) => error.code === FAILURE.DNS_NAME_FORBIDDEN,
      `expected ${host} to be refused`
    )
  }
  assert.equal(assertCreatableHost('example.com', 'Links.Example.com.'), 'links.example.com')
  assert.equal(assertCreatableHost('example.com', '_railway-verify.links.example.com'), '_railway-verify.links.example.com')
})

test('a name that already exists is never overwritten', async () => {
  const { fetchImpl, calls } = responder([ok([{ id: 'r1', type: 'A', name: 'links.example.com', content: '1.2.3.4' }])])

  await assert.rejects(
    () => createRecord(new Secret(SENTINEL), 'z1', { type: 'CNAME', name: 'links.example.com', value: 'x.up.railway.app' }, { fetchImpl }),
    (error) => {
      assert.equal(error.code, FAILURE.DNS_RECORD_EXISTS)
      assert.deepEqual(error.context, { name: 'links.example.com', type: 'A' })
      return true
    }
  )
  // One call: the read. Nothing was written.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('a created record is DNS-only, because the orange cloud blocks certificate issuance', async () => {
  const { fetchImpl, calls } = responder([ok([]), ok({ id: 'r9' })])

  const created = await createRecord(
    new Secret(SENTINEL),
    'z1',
    { type: 'CNAME', name: 'links.example.com', value: 'x.up.railway.app' },
    { fetchImpl }
  )

  assert.deepEqual(created, { id: 'r9', type: 'CNAME', name: 'links.example.com', value: 'x.up.railway.app' })
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].body.proxied, false)
  assert.equal(calls[1].body.content, 'x.up.railway.app')
})

test('a record lost to a race between the read and the write is still not an overwrite', async () => {
  const { fetchImpl } = responder([ok([]), { status: 400, body: { success: false, errors: [{ code: 81053 }] } }])
  await assert.rejects(
    () => createRecord(new Secret(SENTINEL), 'z1', { type: 'CNAME', name: 'links.example.com', value: 'x' }, { fetchImpl }),
    (error) => error.code === FAILURE.DNS_RECORD_EXISTS
  )
})

test('rollback deletes by record id', async () => {
  const { fetchImpl, calls } = responder([ok(null)])
  await deleteRecord(new Secret(SENTINEL), 'z1', 'r9', { fetchImpl })
  assert.equal(calls[0].method, 'DELETE')
  assert.match(calls[0].url, /\/zones\/z1\/dns_records\/r9$/)
})
