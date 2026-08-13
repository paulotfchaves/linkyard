import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { deriveKey, seal, open, last4 } from '../vault.mjs'
import { Secret } from '../secret.mjs'

const MASTER = 'a-master-key-of-sufficient-length-for-testing'
const FIXTURE = 'ly-fixture-0123456789-abcdefghij-value'

test('round-trips a value', () => {
  const key = deriveKey(MASTER)
  const sealed = seal(key, FIXTURE)
  assert.ok(Buffer.isBuffer(sealed))
  const opened = open(key, sealed)
  assert.ok(opened instanceof Secret, 'open must return a Secret, not a bare string')
  assert.equal(opened.reveal(), FIXTURE)
})

test('accepts a Secret as input', () => {
  const key = deriveKey(MASTER)
  assert.equal(open(key, seal(key, new Secret(FIXTURE))).reveal(), FIXTURE)
})

test('the sealed buffer does not contain the plaintext', () => {
  const sealed = seal(deriveKey(MASTER), FIXTURE)
  assert.ok(!sealed.includes(Buffer.from(FIXTURE, 'utf8')), 'ciphertext must not contain plaintext')
  assert.ok(!sealed.toString('utf8').includes(FIXTURE))
  assert.ok(!sealed.toString('hex').includes(Buffer.from(FIXTURE).toString('hex')))
})

test('sealing the same value twice produces different ciphertext', () => {
  const key = deriveKey(MASTER)
  assert.notEqual(seal(key, FIXTURE).toString('hex'), seal(key, FIXTURE).toString('hex'))
})

test('a tampered ciphertext is rejected, not silently decrypted', () => {
  const key = deriveKey(MASTER)
  const sealed = seal(key, FIXTURE)
  sealed[sealed.length - 1] ^= 0xff
  assert.throws(() => open(key, sealed), /unable to open/)
})

test('a tampered nonce is rejected', () => {
  const key = deriveKey(MASTER)
  const sealed = seal(key, FIXTURE)
  sealed[0] ^= 0xff
  assert.throws(() => open(key, sealed), /unable to open/)
})

test('the wrong key is rejected', () => {
  const sealed = seal(deriveKey(MASTER), FIXTURE)
  assert.throws(
    () => open(deriveKey('a-different-master-key-entirely-here-ok'), sealed),
    /unable to open/
  )
})

test('the failure message never reveals why', () => {
  const key = deriveKey(MASTER)
  const sealed = seal(key, FIXTURE)
  sealed[sealed.length - 1] ^= 0xff
  try {
    open(key, sealed)
    assert.fail('should have thrown')
  } catch (err) {
    assert.equal(err.message, 'unable to open sealed value')
    assert.ok(!err.message.includes(FIXTURE))
    assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(FIXTURE))
  }
})

test('deriveKey is deterministic and 32 bytes', () => {
  const a = deriveKey(MASTER)
  const b = deriveKey(MASTER)
  assert.equal(a.length, 32)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, deriveKey('another-master-key-of-good-length-here'))
})

test('deriveKey rejects a short master key', () => {
  assert.throws(() => deriveKey('short'), /at least 32 characters/)
  assert.throws(() => deriveKey(null), /at least 32 characters/)
})

test('last4 returns the final four characters', () => {
  assert.equal(last4(FIXTURE), 'alue')
  assert.equal(last4(new Secret(FIXTURE)), 'alue')
  assert.throws(() => last4('abc'), /too short/)
})

test('a random 1000-value corpus never round-trips wrong', () => {
  const key = deriveKey(MASTER)
  for (let i = 0; i < 1000; i++) {
    const value = randomBytes(24).toString('base64url')
    assert.equal(open(key, seal(key, value)).reveal(), value)
  }
})
