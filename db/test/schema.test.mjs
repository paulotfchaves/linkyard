import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate, MIGRATIONS_DIR } from '../migrate.mjs'
import { freshDatabase } from './helpers.mjs'

async function migratedDatabase(schemaName) {
  const db = await freshDatabase(schemaName)
  await migrate(db.pool, MIGRATIONS_DIR)
  return db
}

test('users: email is unique and case-insensitive', async (t) => {
  const db = await migratedDatabase('schema_users')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('ana', 'Ana@Example.com', 'x', 'owner')`
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ('ana2', 'ana@example.com', 'x', 'admin')`
      ),
    /duplicate key/
  )
})

test('users: role is constrained to the four known roles', async (t) => {
  const db = await migratedDatabase('schema_roles')
  t.after(() => db.end())

  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ('x', 'x@example.com', 'x', 'superuser')`
      ),
    /users_role_check/
  )
})

test('users: timezone defaults to UTC and locale to en', async (t) => {
  const db = await migratedDatabase('schema_defaults')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('x', 'x@example.com', 'x', 'owner')
     RETURNING timezone, locale, status`
  )
  assert.equal(rows[0].timezone, 'UTC')
  assert.equal(rows[0].locale, 'en')
  assert.equal(rows[0].status, 'active')
})

test('sessions: cascade-delete with the user', async (t) => {
  const db = await migratedDatabase('schema_sessions')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('x', 'x@example.com', 'x', 'owner') RETURNING id`
  )
  const userId = rows[0].id
  await db.pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, 'hash', now() + interval '1 day')`,
    [userId]
  )
  await db.pool.query('DELETE FROM users WHERE id = $1', [userId])
  const { rows: left } = await db.pool.query('SELECT count(*)::int AS n FROM sessions')
  assert.equal(left[0].n, 0)
})

test('grants: resource and action are constrained', async (t) => {
  const db = await migratedDatabase('schema_grants')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('x', 'x@example.com', 'x', 'viewer') RETURNING id`
  )
  const userId = rows[0].id

  await db.pool.query(
    `INSERT INTO grants (user_id, resource, action) VALUES ($1, 'link', 'create')`,
    [userId]
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO grants (user_id, resource, action) VALUES ($1, 'billing', 'create')`,
        [userId]
      ),
    /grants_resource_check/
  )
})

test('settings: key is the primary key and value is jsonb', async (t) => {
  const db = await migratedDatabase('schema_settings')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO settings (key, value) VALUES ('probe_number', '180'::jsonb)`
  )
  const { rows } = await db.pool.query(
    `SELECT value FROM settings WHERE key = 'probe_number'`
  )
  assert.equal(rows[0].value, 180)
})

// ── infrastructure ──────────────────────────────────────────────────────────

test('credentials: only ciphertext is stored, never a plaintext column', async (t) => {
  const db = await migratedDatabase('schema_creds')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'schema_creds' AND table_name = 'credentials'
      ORDER BY column_name`
  )
  const cols = rows.map((r) => r.column_name)
  assert.ok(cols.includes('ciphertext'), 'ciphertext column must exist')
  for (const forbidden of ['token', 'plaintext', 'secret', 'value']) {
    assert.ok(!cols.includes(forbidden), `credentials must not have a "${forbidden}" column`)
  }
})

test('credentials: one row per provider and label', async (t) => {
  const db = await migratedDatabase('schema_creds_unique')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO credentials (provider, label, ciphertext, last4)
     VALUES ('cloudflare', 'main', '\\x00'::bytea, 'ab12')`
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO credentials (provider, label, ciphertext, last4)
         VALUES ('cloudflare', 'main', '\\x01'::bytea, 'cd34')`
      ),
    /duplicate key/
  )
})

test('domains: root_policy is constrained and custom_url needs a target', async (t) => {
  const db = await migratedDatabase('schema_domains')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex')`
  )
  await assert.rejects(
    () => db.pool.query(`INSERT INTO domains (apex, root_policy) VALUES ('b.com', 'four_oh_four')`),
    /domains_root_policy_check/
  )
  await assert.rejects(
    () => db.pool.query(`INSERT INTO domains (apex, root_policy) VALUES ('c.com', 'custom_url')`),
    /domains_custom_url_needs_target/
  )
})

test('subdomains: host is globally unique and cascades from its domain', async (t) => {
  const db = await migratedDatabase('schema_subdomains')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  const domainId = rows[0].id

  await db.pool.query(`INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.example.com')`, [
    domainId,
  ])
  await assert.rejects(
    () =>
      db.pool.query(`INSERT INTO subdomains (domain_id, host) VALUES ($1, 'GO.example.com')`, [
        domainId,
      ]),
    /duplicate key/
  )

  await db.pool.query('DELETE FROM domains WHERE id = $1', [domainId])
  const { rows: left } = await db.pool.query('SELECT count(*)::int AS n FROM subdomains')
  assert.equal(left[0].n, 0)
})
