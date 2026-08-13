import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { closePool, query } from '../app/lib/db.server.ts'
import { ARGON2_PARAMS, hashPassword, verifyPassword } from '../app/lib/password.server.ts'
import {
  ABSOLUTE_TIMEOUT_DAYS,
  IDLE_TIMEOUT_DAYS,
  SESSION_COOKIE,
  clearedCookieHeader,
  createSession,
  resolveSession,
  revokeSession,
  sessionCookieHeader,
} from '../app/lib/session.server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SCHEMA = 'panel_sessions'

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/linkyard_test'

// getPool() reads DATABASE_URL on the first query, not at import time, so
// setting it here still lands. The whole file shares one pool and therefore one
// schema; search_path travels inside the connection string rather than as a SET
// after connect, because a pooled connection can be handed out before such a
// SET has run.
process.env.DATABASE_URL = `${TEST_URL}?options=${encodeURIComponent(
  `-c search_path=${SCHEMA},public`
)}`

// db/ is plain .mjs with no declarations. A computed specifier keeps a
// type-check of the panel workspace from having to resolve it, while Node still
// resolves it normally at run time.
type TestDatabase = { pool: unknown; end(): Promise<void> }
const helpers = (await import(pathToFileURL(join(REPO, 'db/test-support/helpers.mjs')).href)) as {
  freshDatabase(schemaName: string): Promise<TestDatabase>
}
const migrator = (await import(pathToFileURL(join(REPO, 'db/migrate.mjs')).href)) as {
  migrate(pool: unknown, dir: string): Promise<string[]>
  MIGRATIONS_DIR: string
}

let db: TestDatabase

before(async () => {
  db = await helpers.freshDatabase(SCHEMA)
  await migrator.migrate(db.pool, migrator.MIGRATIONS_DIR)
})

after(async () => {
  await closePool()
  await db.end()
})

const DAY_MS = 86_400_000
let seq = 0

async function seedUser(role = 'editor'): Promise<string> {
  seq += 1
  const rows = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role, timezone, locale)
     VALUES ($1, $2, 'placeholder', $3, 'America/Sao_Paulo', 'pt-BR')
     RETURNING id`,
    [`user${seq}`, `user${seq}@example.com`, role]
  )
  return rows[0].id
}

function requestWith(cookie: string | null): Request {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  return new Request('https://panel.example/dashboard', { headers })
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sessionRow(userId: string): Promise<Record<string, string | null>> {
  const rows = await query<{ row: Record<string, string | null> }>(
    'SELECT to_jsonb(s) AS row FROM sessions s WHERE s.user_id = $1',
    [userId]
  )
  assert.equal(rows.length, 1, 'expected exactly one session for this user')
  return rows[0].row
}

// ── password hashing ────────────────────────────────────────────────────────

test('hashPassword produces an Argon2id digest carrying the pinned parameters', async () => {
  const digest = await hashPassword('correct horse battery staple')

  assert.ok(digest.startsWith('$argon2id$'), `expected an Argon2id digest, got ${digest.slice(0, 20)}`)
  assert.ok(
    digest.includes(`m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}`),
    `digest must encode the pinned cost parameters: ${digest}`
  )
  assert.ok(!digest.includes('correct horse'), 'the plaintext must never appear in the digest')
})

test('hashPassword salts every digest, so the same password hashes differently', async () => {
  const a = await hashPassword('same-password')
  const b = await hashPassword('same-password')

  assert.notEqual(a, b)
  assert.equal(await verifyPassword(a, 'same-password'), true)
  assert.equal(await verifyPassword(b, 'same-password'), true)
})

test('verifyPassword accepts the right password and rejects a wrong one', async () => {
  const digest = await hashPassword('s3cret-passphrase')

  assert.equal(await verifyPassword(digest, 's3cret-passphrase'), true)
  assert.equal(await verifyPassword(digest, 's3cret-passphras'), false)
  assert.equal(await verifyPassword(digest, ''), false)
})

test('verifyPassword returns false on a malformed hash instead of throwing', async () => {
  for (const malformed of ['', 'not-a-hash', '$argon2id$', '$argon2id$v=19$m=19456,t=2,p=1$abc', 'x'.repeat(300)]) {
    assert.equal(
      await verifyPassword(malformed, 'anything'),
      false,
      `a malformed hash (${JSON.stringify(malformed.slice(0, 24))}) must read as "wrong password"`
    )
  }
})

// ── what the sessions table is allowed to hold ──────────────────────────────

test('the sessions row stores only the SHA-256 of the token, never the token', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, { ip: '203.0.113.9', userAgent: 'probe/1.0' })

  const row = await sessionRow(userId)
  const dump = JSON.stringify(row)

  assert.ok(!dump.includes(token), 'the raw token must not appear in any column of the row')
  assert.equal(row.token_hash, sha256(token), 'the stored value must be the SHA-256 of the token')
  assert.ok(!dump.includes(Buffer.from(token).toString('base64')), 'nor any re-encoding of it')
})

test('createSession records the caller metadata and drops a non-address ip', async () => {
  const withIp = await seedUser()
  await createSession(withIp, { ip: '198.51.100.4', userAgent: 'panel-test' })
  const good = await sessionRow(withIp)
  assert.equal(good.ip, '198.51.100.4')
  assert.equal(good.user_agent, 'panel-test')

  // inet rejects junk, and a proxy header can carry anything: a bad value must
  // cost the login nothing.
  const withJunk = await seedUser()
  await createSession(withJunk, { ip: 'unknown, 10.0.0.1', userAgent: null })
  const junk = await sessionRow(withJunk)
  assert.equal(junk.ip, null)
  assert.equal(junk.user_agent, null)
})

// ── the cookie ──────────────────────────────────────────────────────────────

test('the session cookie is HttpOnly, SameSite=Lax and scoped to the whole site', () => {
  const header = sessionCookieHeader('token-value', new Date(Date.now() + 7 * DAY_MS))

  assert.ok(header.startsWith(`${SESSION_COOKIE}=token-value;`), header)
  assert.match(header, /;\s*HttpOnly\b/)
  assert.match(header, /;\s*SameSite=Lax\b/)
  assert.match(header, /;\s*Path=\/(;|$)/)
})

test('the cookie carries the __Host- prefix and the flags that prefix demands', () => {
  const expiresAt = new Date(Date.now() + 7 * DAY_MS)

  // __Host- is what stops a sibling subdomain — which this product creates by
  // the dozen — from planting a session cookie for the panel. Browsers enforce
  // it only when Secure is present and Domain is absent, so both are asserted
  // here and in every environment, not just production.
  assert.ok(SESSION_COOKIE.startsWith('__Host-'), SESSION_COOKIE)

  for (const env of ['production', 'development', undefined]) {
    const previous = process.env.NODE_ENV
    try {
      if (env === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = env

      for (const header of [sessionCookieHeader('t', expiresAt), clearedCookieHeader()]) {
        assert.match(header, /;\s*Secure\b/, `Secure missing with NODE_ENV=${env}`)
        assert.match(header, /;\s*HttpOnly\b/)
        assert.match(header, /;\s*Path=\//)
        assert.doesNotMatch(header, /;\s*Domain=/i, 'a Domain attribute voids the __Host- prefix')
      }
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
  }
})

test('a duplicated session cookie resolves to nobody rather than to the first one', async () => {
  // Cookie order is creation time, not something the server controls. If a
  // duplicate ever arrives, refusing is the only safe answer: choosing would
  // mean letting whoever planted the extra cookie pick the identity.
  const request = new Request('https://panel.example.com/', {
    headers: { cookie: `${SESSION_COOKIE}=attacker-token; ${SESSION_COOKIE}=victim-token` },
  })
  assert.equal(await resolveSession(request), null)
})

test('clearedCookieHeader expires the cookie immediately with the same flags', () => {
  const header = clearedCookieHeader()

  assert.ok(header.startsWith(`${SESSION_COOKIE}=;`), header)
  assert.match(header, /;\s*Max-Age=0\b/)
  assert.match(header, /;\s*HttpOnly\b/)
  assert.match(header, /;\s*SameSite=Lax\b/)
  assert.match(header, /;\s*Path=\/(;|$)/)
})

// ── resolving ───────────────────────────────────────────────────────────────

test('resolveSession returns the user behind a valid cookie', async () => {
  const userId = await seedUser('admin')
  const { token } = await createSession(userId, { ip: null, userAgent: null })

  const user = await resolveSession(requestWith(cookieFor(token)))

  assert.ok(user, 'a fresh session must resolve')
  assert.equal(user.id, userId)
  assert.equal(user.role, 'admin')
  assert.equal(user.timezone, 'America/Sao_Paulo')
  assert.equal(user.locale, 'pt-BR')
  assert.match(user.email, /@example\.com$/)
  assert.ok(user.sessionId, 'the session id must travel with the user')
})

test('resolveSession returns null with no cookie, an empty cookie or an unknown token', async () => {
  assert.equal(await resolveSession(requestWith(null)), null)
  assert.equal(await resolveSession(requestWith(`${SESSION_COOKIE}=`)), null)
  assert.equal(await resolveSession(requestWith('other=value')), null)
  assert.equal(await resolveSession(requestWith(cookieFor('a-token-that-was-never-issued'))), null)
})

test('resolveSession finds the cookie among several and ignores lookalike names', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})

  const mixed = `theme=dark; ${SESSION_COOKIE}_old=stale; ${SESSION_COOKIE}=${token}; tz=UTC`
  const user = await resolveSession(requestWith(mixed))

  assert.ok(user)
  assert.equal(user.id, userId)
})

// ── the two clocks ──────────────────────────────────────────────────────────

test('resolveSession slides expires_at forward by the idle timeout on every resolve', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})

  // Stand in for a week of quiet: the session is minutes from lapsing.
  await query(
    `UPDATE sessions SET expires_at = now() + interval '10 minutes' WHERE user_id = $1`,
    [userId]
  )

  assert.ok(await resolveSession(requestWith(cookieFor(token))), 'a live session must resolve')

  const row = await sessionRow(userId)
  const expiresAt = new Date(row.expires_at as string).getTime()
  const target = Date.now() + IDLE_TIMEOUT_DAYS * DAY_MS

  assert.ok(
    Math.abs(expiresAt - target) < 60_000,
    `expires_at must slide to about ${IDLE_TIMEOUT_DAYS} days out, got ${row.expires_at}`
  )
})

test('the slide never pushes a session past the absolute timeout', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})

  // One day short of the absolute ceiling, and still active.
  await query(
    `UPDATE sessions
        SET created_at = now() - make_interval(days => $2),
            expires_at = now() + interval '1 hour'
      WHERE user_id = $1`,
    [userId, ABSOLUTE_TIMEOUT_DAYS - 1]
  )

  assert.ok(await resolveSession(requestWith(cookieFor(token))))

  const row = await sessionRow(userId)
  const createdAt = new Date(row.created_at as string).getTime()
  const expiresAt = new Date(row.expires_at as string).getTime()
  const ceiling = createdAt + ABSOLUTE_TIMEOUT_DAYS * DAY_MS

  assert.ok(
    expiresAt <= ceiling + 1_000,
    `expires_at ${row.expires_at} must not pass the ceiling ${new Date(ceiling).toISOString()}`
  )
  assert.ok(
    expiresAt < Date.now() + 2 * DAY_MS,
    'an old session must not be handed a fresh idle window'
  )
})

test('an expired session stops resolving', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})
  await query(
    `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
    [userId]
  )

  assert.equal(await resolveSession(requestWith(cookieFor(token))), null)
})

test('a session past its absolute ceiling stops resolving even if recently active', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})
  await query(
    `UPDATE sessions
        SET created_at = now() - make_interval(days => $2),
            expires_at = now() + interval '1 hour'
      WHERE user_id = $1`,
    [userId, ABSOLUTE_TIMEOUT_DAYS + 1]
  )

  assert.equal(
    await resolveSession(requestWith(cookieFor(token))),
    null,
    'the resolve itself must pull expires_at back behind now()'
  )
})

// ── revocation and deletion ─────────────────────────────────────────────────

test('a revoked session stops resolving immediately', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})
  const request = requestWith(cookieFor(token))

  assert.ok(await resolveSession(request), 'sanity: it resolved before the revoke')

  await revokeSession(request)

  assert.equal(await resolveSession(request), null)
  const row = await sessionRow(userId)
  assert.ok(row.revoked_at, 'revoked_at must be stamped on the row')
})

test('revokeSession is a no-op without a cookie and never revokes another session', async () => {
  const keeper = await seedUser()
  const { token } = await createSession(keeper, {})

  await revokeSession(requestWith(null))
  await revokeSession(requestWith(cookieFor('a-token-that-was-never-issued')))

  assert.ok(await resolveSession(requestWith(cookieFor(token))), 'the live session must survive')
  assert.equal((await sessionRow(keeper)).revoked_at, null)
})

test('a session whose user was deleted stops resolving', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})
  const request = requestWith(cookieFor(token))

  assert.ok(await resolveSession(request), 'sanity: it resolved while the user existed')

  await query('DELETE FROM users WHERE id = $1', [userId])

  assert.equal(await resolveSession(request), null)
})

test('a suspended user stops resolving without the session being revoked', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})

  await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userId])

  assert.equal(await resolveSession(requestWith(cookieFor(token))), null)
})

// ── how the token is looked up ──────────────────────────────────────────────

test('a token that differs by one character does not resolve', async () => {
  const userId = await seedUser()
  const { token } = await createSession(userId, {})
  const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')

  assert.notEqual(flipped, token)
  assert.equal(await resolveSession(requestWith(cookieFor(flipped))), null)
})

test('a raw token stored in token_hash never resolves', async () => {
  // Behavioural proof, replacing a source grep that certified this property
  // without checking it: the grep was satisfied by revokeSession's WHERE clause
  // and could be defeated by renaming a variable.
  //
  // Plant a row whose token_hash column literally holds a raw token. If the
  // lookup ever stopped digesting the cookie — comparing the stored value
  // directly instead — this request would resolve. It must not, however the
  // code is spelled.
  const userId = await seedUser()
  const raw = 'a-raw-token-that-was-never-hashed'

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '7 days')`,
    [userId, raw]
  )

  const request = new Request('https://panel.example.com/', {
    headers: { cookie: `${SESSION_COOKIE}=${raw}` },
  })
  assert.equal(await resolveSession(request), null)
})
