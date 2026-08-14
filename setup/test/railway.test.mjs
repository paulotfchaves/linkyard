import test from 'node:test'
import assert from 'node:assert/strict'
import { FAILURE, Secret } from '../src/secret.mjs'
import {
  createCustomDomain,
  deleteApiToken,
  destroyToken,
  displayTokenFor,
  findApiTokenId,
  graphql,
  resolveAccount,
} from '../src/railway.mjs'

const SENTINEL = 'abcd-sentinel-token-never-logged-wxyz'

function responder(steps) {
  const calls = []
  const queue = [...steps]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) })
    const next = queue.shift()
    if (!next) throw new Error('unexpected call')
    if (next.throws) throw new Error(`socket hang up while sending ${init.headers.authorization}`)
    return {
      ok: next.status === undefined ? true : next.status < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    }
  }
  return { fetchImpl, calls }
}

test('the token is revealed once, in the Authorization header, and nowhere else', async () => {
  const { fetchImpl, calls } = responder([{ body: { data: { ok: true } } }])
  await graphql(new Secret(SENTINEL), 'query{ok}', {}, { fetchImpl })

  assert.equal(calls[0].init.headers.authorization, `Bearer ${SENTINEL}`)
  assert.equal(calls[0].init.body.includes(SENTINEL), false)
})

test('a GraphQL error array never reaches the caller as text', async () => {
  const { fetchImpl } = responder([
    { body: { errors: [{ message: `Problem processing request with token ${SENTINEL}` }] } },
  ])

  await assert.rejects(
    () => graphql(new Secret(SENTINEL), 'query{ok}', {}, { fetchImpl }),
    (error) => {
      assert.equal(error.code, FAILURE.RAILWAY_API_FAILED)
      assert.equal(JSON.stringify(error.toJSON()).includes(SENTINEL), false)
      assert.equal(error.message.includes(SENTINEL), false)
      return true
    }
  )
})

test('a network failure is not wrapped, because the thrown error carries the request', async () => {
  const { fetchImpl } = responder([{ throws: true }])
  await assert.rejects(
    () => graphql(new Secret(SENTINEL), 'query{ok}', {}, { fetchImpl }),
    (error) => {
      assert.equal(error.code, FAILURE.RAILWAY_UNREACHABLE)
      assert.equal(error.message.includes(SENTINEL), false)
      return true
    }
  )
})

test('a project token is named as such instead of being called invalid', async () => {
  const { fetchImpl } = responder([{ status: 401, body: { errors: [{ message: 'Not Authorized' }] } }])
  await assert.rejects(
    () => resolveAccount(new Secret(SENTINEL), { fetchImpl }),
    (error) => error.code === FAILURE.RAILWAY_TOKEN_NOT_ACCOUNT
  )
})

test('resolveAccount reports which account answered, for the confirmation screen', async () => {
  const { fetchImpl } = responder([
    { body: { data: { me: { id: 'u1', email: 'owner@example.com', name: 'Owner', workspaces: [{ id: 'w1', name: 'Personal' }] } } } },
  ])
  const account = await resolveAccount(new Secret(SENTINEL), { fetchImpl })
  assert.deepEqual(account, {
    accountEmail: 'owner@example.com',
    accountName: 'Owner',
    workspaceId: 'w1',
    workspaceName: 'Personal',
    workspaceCount: 1,
  })
})

test('displayToken is the first four and last four characters', () => {
  assert.equal(displayTokenFor('1c3fabcdefghee54'), '1c3f-****-ee54')
})

test('the token to delete is found by matching both ends, and ambiguity refuses', async () => {
  const value = '1c3fabcdefghee54'
  const list = (nodes) => ({ body: { data: { apiTokens: { edges: nodes.map((node) => ({ node })) } } } })

  const found = responder([list([{ id: 'a', displayToken: 'zzzz-****-yyyy' }, { id: 'b', displayToken: '1c3f-****-ee54' }])])
  assert.equal(await findApiTokenId(new Secret(value), { fetchImpl: found.fetchImpl }), 'b')

  const none = responder([list([{ id: 'a', displayToken: 'zzzz-****-yyyy' }])])
  await assert.rejects(
    () => findApiTokenId(new Secret(value), { fetchImpl: none.fetchImpl }),
    (error) => error.code === FAILURE.RAILWAY_TOKEN_NOT_FOUND
  )

  const twins = responder([list([{ id: 'a', displayToken: '1c3f-****-ee54' }, { id: 'b', displayToken: '1c3f-****-ee54' }])])
  await assert.rejects(
    () => findApiTokenId(new Secret(value), { fetchImpl: twins.fetchImpl }),
    (error) => error.code === FAILURE.RAILWAY_TOKEN_AMBIGUOUS
  )
})

test('destroyToken deletes the token and confirms with a call that must fail', async () => {
  const value = '1c3fabcdefghee54'
  const { fetchImpl, calls } = responder([
    { body: { data: { apiTokens: { edges: [{ node: { id: 'tok', displayToken: '1c3f-****-ee54' } }] } } } },
    { body: { data: { apiTokenDelete: true } } },
    { status: 401, body: { errors: [{ message: 'Not Authorized' }] } },
  ])

  const outcome = await destroyToken(new Secret(value), { fetchImpl })
  assert.deepEqual(outcome, { deleted: true, confirmed: true, code: null })
  assert.equal(calls.length, 3)
  assert.match(calls[1].payload.query, /apiTokenDelete/)
  assert.match(calls[2].payload.query, /me\{id\}/)
})

test('a token that still answers after the delete is reported unconfirmed, not as success', async () => {
  const value = '1c3fabcdefghee54'
  const { fetchImpl } = responder([
    { body: { data: { apiTokens: { edges: [{ node: { id: 'tok', displayToken: '1c3f-****-ee54' } }] } } } },
    { body: { data: { apiTokenDelete: true } } },
    { body: { data: { me: { id: 'u1' } } } },
  ])

  assert.deepEqual(await destroyToken(new Secret(value), { fetchImpl }), {
    deleted: true,
    confirmed: false,
    code: null,
  })
})

test('destroyToken never throws, because it runs in the finally of a failing job', async () => {
  const { fetchImpl } = responder([{ throws: true }])
  const outcome = await destroyToken(new Secret(SENTINEL), { fetchImpl })
  assert.equal(outcome.deleted, false)
  assert.equal(outcome.code, FAILURE.RAILWAY_UNREACHABLE)
})

test('a custom domain without DNS records is a failure, not an empty plan', async () => {
  const withRecords = responder([
    {
      body: {
        data: {
          customDomainCreate: {
            id: 'cd1',
            domain: 'links.example.com',
            status: {
              dnsRecords: [
                { hostlabel: 'links', recordType: 'CNAME', requiredValue: 'abc.up.railway.app', zone: 'example.com' },
                { hostlabel: '_railway-verify.links', recordType: 'TXT', requiredValue: 'token', zone: 'example.com' },
              ],
            },
          },
        },
      },
    },
  ])

  const created = await createCustomDomain(
    new Secret(SENTINEL),
    { projectId: 'p', environmentId: 'e', serviceId: 's', domain: 'links.example.com', targetPort: 3000 },
    { fetchImpl: withRecords.fetchImpl }
  )
  assert.deepEqual(created.records, [
    { type: 'CNAME', name: 'links.example.com', value: 'abc.up.railway.app' },
    { type: 'TXT', name: '_railway-verify.links.example.com', value: 'token' },
  ])

  const empty = responder([{ body: { data: { customDomainCreate: { id: 'cd1', status: { dnsRecords: [] } } } } }])
  await assert.rejects(
    () =>
      createCustomDomain(
        new Secret(SENTINEL),
        { projectId: 'p', environmentId: 'e', serviceId: 's', domain: 'links.example.com', targetPort: 3000 },
        { fetchImpl: empty.fetchImpl }
      ),
    (error) => error.code === FAILURE.RAILWAY_DOMAIN_RECORDS_MISSING
  )
})

test('deleteApiToken sends the id Railway expects', async () => {
  const { fetchImpl, calls } = responder([{ body: { data: { apiTokenDelete: true } } }])
  await deleteApiToken(new Secret(SENTINEL), 'tok-1', { fetchImpl })
  assert.deepEqual(calls[0].payload.variables, { id: 'tok-1' })
})
