import test from 'node:test'
import assert from 'node:assert/strict'
import { assertHost, assertRealSecret, buildInstall, composeEnv, generateSecret } from '../src/env.mjs'

test('every generated secret clears the vault floor', () => {
  for (let i = 0; i < 20; i += 1) {
    const secret = generateSecret()
    assert.ok(secret.length >= 32, `too short: ${secret.length}`)
    assert.doesNotThrow(() => assertRealSecret('X', secret))
  }
})

test('a template placeholder is refused, whatever its length', () => {
  // The 35-character version of this string passed a length check once and
  // became the encryption key for every installation that shipped it.
  assert.throws(() => assertRealSecret('ENCRYPTION_KEY', '${{secret(64, "ENCRYPTION_KEY")}}'), /placeholder/)
  assert.throws(() => assertRealSecret('ENCRYPTION_KEY', '${{'.padEnd(80, 'a')), /placeholder/)
})

test('a word somebody typed instead of a secret is refused', () => {
  for (const word of ['changeme', 'CHANGEME', 'password', 'todo']) {
    assert.throws(() => assertRealSecret('X', word), /placeholder|32 characters/)
  }
})

test('a hostname is checked label by label', () => {
  for (const bad of ['', 'localhost', 'a b.example.com', '..example.com', '-x.example.com', 'x-.example.com']) {
    assert.throws(() => assertHost('HOST', bad), /required|not a valid/, bad)
  }
  assert.equal(assertHost('HOST', 'Panel.Example.COM.'), 'panel.example.com')
  assert.equal(assertHost('HOST', '_railway-verify.example.com'), '_railway-verify.example.com')
})

test('the panel host may not equal the redirect apex', () => {
  // Same host means the panel occupies the root of the domain every short link
  // lives under, so `/settings` is both a page and a slug somebody can claim.
  assert.throws(
    () => buildInstall({ panelHost: 'example.com', redirectApex: 'example.com', acmeEmail: 'a@b.co' }),
    /must differ/
  )
})

test('an install is fully populated and every secret is distinct', () => {
  const values = buildInstall({
    panelHost: 'panel.example.com',
    redirectApex: 'example.com',
    acmeEmail: 'ops@example.com',
  })

  for (const key of ['ENCRYPTION_KEY', 'IP_HASH_SALT', 'SETUP_TOKEN', 'POSTGRES_PASSWORD']) {
    assert.ok(values[key]?.length >= 32 || key === 'POSTGRES_PASSWORD', key)
  }

  // Reusing one value across three roles means one leak is three leaks.
  const secrets = [values.ENCRYPTION_KEY, values.IP_HASH_SALT, values.SETUP_TOKEN, values.POSTGRES_PASSWORD]
  assert.equal(new Set(secrets).size, secrets.length, 'secrets must not repeat')

  assert.equal(values.PANEL_ORIGIN, 'https://panel.example.com')
})

test('two installs never share a secret', () => {
  const a = buildInstall({ panelHost: 'p.example.com', redirectApex: 'example.com', acmeEmail: 'a@b.co' })
  const b = buildInstall({ panelHost: 'p.example.com', redirectApex: 'example.com', acmeEmail: 'a@b.co' })
  assert.notEqual(a.ENCRYPTION_KEY, b.ENCRYPTION_KEY)
  assert.notEqual(a.IP_HASH_SALT, b.IP_HASH_SALT)
})

test('every value is quoted, so a secret starting with shell syntax survives', () => {
  const file = composeEnv({ A: 'plain', B: '#not-a-comment', C: 'has spaces', D: '$(whoami)' })
  assert.match(file, /^A="plain"$/m)
  assert.match(file, /^B="#not-a-comment"$/m)
  assert.match(file, /^C="has spaces"$/m)
  assert.match(file, /^D="\$\(whoami\)"$/m)
})
