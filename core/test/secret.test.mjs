import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { Secret, isSecret } from '../secret.mjs'

const FIXTURE = 'ly-fixture-0123456789-abcdefghij-value'

test('reveal returns the real value', () => {
  assert.equal(new Secret(FIXTURE).reveal(), FIXTURE)
})

test('every string form is redacted', () => {
  const s = new Secret(FIXTURE)
  assert.equal(String(s), '[redacted]')
  assert.equal(`${s}`, '[redacted]')
  assert.equal(s + '', '[redacted]')
  assert.equal(JSON.stringify(s), '"[redacted]"')
  assert.equal(inspect(s), '[redacted]')
  // A custom inspect returns its string verbatim, without quoting it.
  assert.equal(inspect({ token: s }), '{ token: [redacted] }')
  assert.ok(!inspect({ token: s }).includes(FIXTURE))
})

test('the value does not leak through a serialized options object', () => {
  // This is the real failure mode: a job argument object reaching console.log
  // or a queue serializer.
  const args = { projectName: 'demo', railwayToken: new Secret(FIXTURE), dryRun: false }
  assert.ok(!JSON.stringify(args).includes(FIXTURE), 'JSON.stringify must not emit the token')
  assert.ok(!inspect(args, { depth: 5 }).includes(FIXTURE), 'inspect must not emit the token')
  assert.ok(!`${args}`.includes(FIXTURE))
})

test('the value is not reachable by enumerating own properties', () => {
  const s = new Secret(FIXTURE)
  assert.deepEqual(Object.keys(s), [])
  assert.deepEqual(Object.values(s), [])
  assert.deepEqual(Object.entries(s), [])
  assert.ok(!JSON.stringify(Object.getOwnPropertyDescriptors(s)).includes(FIXTURE))
})

test('isSecret recognises the wrapper', () => {
  assert.equal(isSecret(new Secret(FIXTURE)), true)
  assert.equal(isSecret(FIXTURE), false)
  assert.equal(isSecret(null), false)
})

test('rejects a non-string or empty value', () => {
  assert.throws(() => new Secret(''), /non-empty string/)
  assert.throws(() => new Secret(null), /non-empty string/)
  assert.throws(() => new Secret(42), /non-empty string/)
})
