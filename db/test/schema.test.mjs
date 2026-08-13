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
