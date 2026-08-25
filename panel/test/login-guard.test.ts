import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  attemptKey,
  clearFailures,
  isLockedOut,
  recordFailure,
  resetGuard,
  verifyOrBurn,
} from '../app/lib/login-guard.server.ts'
import { hashPassword } from '../app/lib/password.server.ts'

beforeEach(() => resetGuard())

test('an address is throttled after enough failures', () => {
  const key = attemptKey('someone@example.com', '203.0.113.9')
  assert.equal(isLockedOut(key), false)

  for (let i = 0; i < 9; i += 1) recordFailure(key)
  assert.equal(isLockedOut(key), false, 'nine failures is still a person mistyping')

  recordFailure(key)
  assert.equal(isLockedOut(key), true)
})

test('the window expires, so a lockout is not permanent', () => {
  const key = attemptKey('someone@example.com', '203.0.113.9')
  const start = 1_000_000

  for (let i = 0; i < 10; i += 1) recordFailure(key, start)
  assert.equal(isLockedOut(key, start), true)

  // Sixteen minutes later the window has rolled over.
  assert.equal(isLockedOut(key, start + 16 * 60 * 1000), false)
})

test('a successful sign-in clears the count', () => {
  const key = attemptKey('someone@example.com', '203.0.113.9')
  for (let i = 0; i < 10; i += 1) recordFailure(key)
  assert.equal(isLockedOut(key), true)

  clearFailures(key)
  assert.equal(isLockedOut(key), false)
})

test('one attacker cannot lock a real user out of their own account', () => {
  // The key carries the source as well as the address. Throttling on the
  // address alone would hand anybody a way to deny an account to its owner by
  // failing ten times against it.
  const victimAtHome = attemptKey('owner@example.com', '198.51.100.4')
  const attacker = attemptKey('owner@example.com', '203.0.113.9')

  for (let i = 0; i < 12; i += 1) recordFailure(attacker)

  assert.equal(isLockedOut(attacker), true)
  assert.equal(isLockedOut(victimAtHome), false, 'the owner must still be able to sign in')
})

test('the rightmost forwarded address is the one counted', () => {
  // Same reasoning as the click pipeline: the left of X-Forwarded-For is
  // whatever the client typed, so keying on it lets an attacker mint a fresh
  // quota per request.
  const forged = attemptKey('someone@example.com', '1.2.3.4, 198.51.100.7')
  const alsoForged = attemptKey('someone@example.com', '9.9.9.9, 198.51.100.7')
  assert.equal(forged, alsoForged, 'a forged left-hand entry must not create a new bucket')
})

test('a missing account costs the same as a wrong password', async () => {
  // The route says an unknown address and a wrong password fail identically.
  // That was true of the text and false of the clock: with no user row the hash
  // was skipped, so a miss returned in about a millisecond against Argon2id's
  // hundred. The gap is measurable over a network, which turns the form into a
  // membership oracle whatever the message says.
  const real = await hashPassword('the-real-password-for-this-test')

  const startHit = process.hrtime.bigint()
  assert.equal(await verifyOrBurn(real, 'wrong-password'), false)
  const hitMs = Number(process.hrtime.bigint() - startHit) / 1e6

  const startMiss = process.hrtime.bigint()
  assert.equal(await verifyOrBurn(null, 'wrong-password'), false)
  const missMs = Number(process.hrtime.bigint() - startMiss) / 1e6

  // Both paths run one Argon2id verification. The bound is loose because this
  // is wall-clock on a shared machine; the defect it guards against was two
  // orders of magnitude, not a few percent.
  const ratio = Math.max(hitMs, missMs) / Math.max(1, Math.min(hitMs, missMs))
  assert.ok(
    ratio < 5,
    `a miss must not be distinguishable by timing: hit ${hitMs.toFixed(1)}ms vs miss ${missMs.toFixed(1)}ms`
  )
})

test('a correct password still succeeds', async () => {
  const hash = await hashPassword('the-real-password-for-this-test')
  assert.equal(await verifyOrBurn(hash, 'the-real-password-for-this-test'), true)
})
