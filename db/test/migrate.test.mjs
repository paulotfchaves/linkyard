import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, appliedVersions } from '../migrate.mjs'
import { freshDatabase } from './helpers.mjs'

async function migrationDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'linkyard-mig-'))
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql)
  }
  return dir
}

test('applies migrations in filename order', async (t) => {
  const db = await freshDatabase('mig_order')
  t.after(() => db.end())

  const dir = await migrationDir({
    '002_second.sql': 'CREATE TABLE second (id int);',
    '001_first.sql': 'CREATE TABLE first (id int);',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const applied = await migrate(db.pool, dir)
  assert.deepEqual(applied, ['001_first', '002_second'])

  const { rows } = await db.pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'mig_order' ORDER BY table_name`
  )
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['first', 'schema_migrations', 'second']
  )
})

test('is idempotent — a second run applies nothing', async (t) => {
  const db = await freshDatabase('mig_idem')
  t.after(() => db.end())

  const dir = await migrationDir({ '001_a.sql': 'CREATE TABLE a (id int);' })
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.deepEqual(await migrate(db.pool, dir), ['001_a'])
  assert.deepEqual(await migrate(db.pool, dir), [])
  assert.deepEqual(await appliedVersions(db.pool), ['001_a'])
})

test('rolls back the whole file when one statement fails', async (t) => {
  const db = await freshDatabase('mig_rollback')
  t.after(() => db.end())

  const dir = await migrationDir({
    '001_bad.sql': 'CREATE TABLE good (id int); CREATE TABLE bad (id nosuchtype);',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  await assert.rejects(() => migrate(db.pool, dir), /nosuchtype/)

  const { rows } = await db.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'mig_rollback'`
  )
  const names = rows.map((r) => r.table_name)
  assert.ok(!names.includes('good'), 'partial migration must not survive')
  assert.deepEqual(await appliedVersions(db.pool), [])
})
