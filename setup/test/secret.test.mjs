import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { FAILURE, ProvisionError, Secret, asProvisionError, isFailureCode } from '../src/secret.mjs'

const SENTINEL = 'sentinel-token-9d3f-do-not-print-ee54'

test('a token never renders as text on any serialization path', () => {
  const token = new Secret(SENTINEL)

  assert.equal(String(token), '[redacted]')
  assert.equal(`${token}`, '[redacted]')
  assert.equal(JSON.stringify({ token }), '{"token":"[redacted]"}')
  assert.equal(inspect(token), '[redacted]')
  assert.equal(inspect({ nested: token }, { depth: 5 }), '{ nested: [redacted] }')
  assert.deepEqual(Object.keys(token), [])
  assert.equal(JSON.stringify({ ...token }), '{}')
})

test('the real value is reachable only through reveal', () => {
  const token = new Secret(SENTINEL)
  assert.equal(token.reveal(), SENTINEL)
})

test('a failure code outside the closed enum cannot be reported', () => {
  assert.throws(() => new ProvisionError('some_upstream_message'), TypeError)
  assert.equal(isFailureCode(FAILURE.DNS_RECORD_EXISTS), true)
  assert.equal(isFailureCode('railway said no'), false)
})

test('failure context refuses a Secret and refuses free-form objects', () => {
  assert.throws(() => new ProvisionError(FAILURE.INTERNAL, { token: new Secret(SENTINEL) }), TypeError)
  assert.throws(() => new ProvisionError(FAILURE.INTERNAL, { upstream: { errors: ['boom'] } }), TypeError)

  const error = new ProvisionError(FAILURE.DNS_RECORD_EXISTS, { name: 'links.example.com' })
  assert.deepEqual(error.toJSON(), { code: 'dns_record_exists', context: { name: 'links.example.com' } })
})

test('an unexpected throw becomes internal instead of leaking its message', () => {
  const wrapped = asProvisionError(new Error(`fetch failed: authorization: Bearer ${SENTINEL}`))
  assert.equal(wrapped.code, FAILURE.INTERNAL)
  assert.equal(JSON.stringify(wrapped.toJSON()).includes(SENTINEL), false)

  const kept = new ProvisionError(FAILURE.CERTIFICATE_TIMEOUT)
  assert.equal(asProvisionError(kept), kept)
})
