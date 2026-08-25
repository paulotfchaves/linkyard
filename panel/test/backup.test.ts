import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { seedDemo } from '../seed/demo.ts'

const load = (path: string) => import(new URL(path, import.meta.url).href)
const { freshDatabase } = await load('../../db/test-support/helpers.mjs')
const { migrate } = await load('../../db/migrate.mjs')
const { exportAll, importAll, assertRestorable, FORMAT } = await load('../../scripts/backup.mjs')

let source: { pool: Pool; end: () => Promise<void> }
let target: { pool: Pool; end: () => Promise<void> }

before(async () => {
  source = await freshDatabase('backup_source')
  await migrate(source.pool)
  await seedDemo(source.pool)

  target = await freshDatabase('backup_target')
  await migrate(target.pool)
})

after(async () => {
  await source?.end()
  await target?.end()
})

test('a backup carries configuration and refuses to carry credentials', async () => {
  const backup = await exportAll(source.pool)

  assert.equal(backup.format, FORMAT)
  assert.ok(backup.data.links.length > 0, 'links must be exported')
  assert.ok(backup.data.domains.length > 0, 'domains must be exported')
  assert.ok(backup.data.users.length > 0, 'users must be exported')

  // The decision this file exists to enforce. A sealed token is unreadable
  // anywhere else, so exporting it produces a restore that silently cannot
  // decrypt; exporting it open turns a backup into a credential leak sitting in
  // whatever bucket the operator drops it in.
  assert.equal(backup.data.credentials, undefined, 'credentials must never be exported')

  // Named tables, not a heuristic. An earlier version of this scanned for any
  // long opaque string, which the seed occasionally produces on its own — a
  // test that fails on a random Tuesday teaches people to re-run it rather than
  // read it.
  const forbidden = ['credentials', 'sessions', 'audit_log', 'click_events']
  for (const table of forbidden) {
    assert.equal(backup.data[table], undefined, `${table} must never be exported`)
  }

  // And no column of any exported row may carry credential material, whatever
  // the table is called.
  const suspicious = /(token|secret|sealed|cipher|nonce|api_key)/i
  for (const [table, rows] of Object.entries(backup.data) as [string, Array<Record<string, unknown>>][]) {
    for (const key of Object.keys(rows[0] ?? {})) {
      assert.ok(!suspicious.test(key), `${table}.${key} looks like credential material`)
    }
  }

  // And history stays out unless asked for: this is measured in millions of
  // rows and is not what somebody rebuilding a service at 3am needs.
  assert.equal(backup.data.click_daily, undefined)
})

test('restoring into an empty database reproduces the links', async () => {
  const backup = await exportAll(source.pool)
  const counts = await importAll(target.pool, backup)

  assert.ok(counts.links > 0, `expected links to be inserted, got ${counts.links}`)

  const before = await source.pool.query('SELECT count(*)::int AS n FROM links')
  const after = await target.pool.query('SELECT count(*)::int AS n FROM links')
  assert.equal(after.rows[0].n, before.rows[0].n, 'every link must survive the round trip')

  // Identity is natural, not the UUID a row happened to be assigned, so the
  // restore is a merge into a fresh database rather than a collision.
  const sample = await target.pool.query(
    `SELECT l.target_url FROM links l JOIN subdomains s ON s.id = l.subdomain_id
      WHERE s.host = $1 AND l.slug = $2`,
    [backup.data.links[0].host, backup.data.links[0].slug]
  )
  assert.equal(sample.rows[0]?.target_url, backup.data.links[0].target_url)
})

test('restoring the same file twice changes nothing the second time', async () => {
  const backup = await exportAll(source.pool)
  const second = await importAll(target.pool, backup)

  // Everything was inserted by the previous test, so a repeat must be a no-op.
  // A restore an operator is afraid to re-run is a restore they will hesitate
  // over at exactly the wrong moment.
  const inserted = Object.values(second as Record<string, number>).reduce((a, b) => a + b, 0)
  assert.equal(inserted, 0, `a repeated restore must insert nothing, inserted ${inserted}`)
})

test('a dry run reports what it would do and writes none of it', async () => {
  const empty = await freshDatabase('backup_dryrun')
  try {
    await migrate(empty.pool)
    const backup = await exportAll(source.pool)

    const would = await importAll(empty.pool, backup, { dryRun: true })
    assert.ok(would.links > 0, 'a dry run must still report the work')

    const after = await empty.pool.query('SELECT count(*)::int AS n FROM links')
    assert.equal(after.rows[0].n, 0, 'a dry run must leave the database untouched')
  } finally {
    await empty.end()
  }
})

test('a file from something else is refused before it touches the database', async () => {
  for (const bad of [null, {}, { format: 'other/1', data: {} }, { format: FORMAT }]) {
    assert.throws(() => assertRestorable(bad), /backup|format|data/)
  }
  assert.throws(() => assertRestorable({ format: FORMAT, data: { links: 'not a list' } }), /must be a list/)
})
