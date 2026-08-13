import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate, MIGRATIONS_DIR } from '../migrate.mjs'
import { ensureUpcomingPartitions, dropExpiredPartitions } from '../retention.mjs'
import { freshDatabase } from '../test-support/helpers.mjs'

async function migrated(schemaName) {
  const db = await freshDatabase(schemaName)
  await migrate(db.pool, MIGRATIONS_DIR)
  return db
}

async function partitionNames(pool, schemaName) {
  const { rows } = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'click_events_2%'
      ORDER BY c.relname`,
    [schemaName]
  )
  return rows.map((r) => r.relname)
}

test('ensureUpcomingPartitions creates this month plus the next three', async (t) => {
  const db = await migrated('ret_upcoming')
  t.after(() => db.end())

  const created = await ensureUpcomingPartitions(db.pool, 3)
  assert.equal(created.length, 4, 'current month plus three ahead')

  const names = await partitionNames(db.pool, 'ret_upcoming')
  assert.equal(names.length, 4)

  // Second run creates nothing new.
  await ensureUpcomingPartitions(db.pool, 3)
  assert.equal((await partitionNames(db.pool, 'ret_upcoming')).length, 4)
})

test('dropExpiredPartitions removes only months older than the retention window', async (t) => {
  const db = await migrated('ret_drop')
  t.after(() => db.end())

  for (const month of ['2020-01-01', '2020-02-01', '2020-03-01']) {
    await db.pool.query('SELECT ensure_click_partition($1::date)', [month])
  }
  await db.pool.query(`SELECT ensure_click_partition(now()::date)`)

  const dropped = await dropExpiredPartitions(db.pool, 30)
  assert.equal(dropped.length, 3, 'the three 2020 partitions must go')
  assert.ok(dropped.every((n) => n.startsWith('click_events_2020_')))

  const left = await partitionNames(db.pool, 'ret_drop')
  assert.equal(left.length, 1, 'the current month survives')
})

test('dropExpiredPartitions never drops the default partition', async (t) => {
  const db = await migrated('ret_default')
  t.after(() => db.end())

  await dropExpiredPartitions(db.pool, 1)
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ret_default' AND c.relname = 'click_events_default'`
  )
  assert.equal(rows[0].n, 1, 'the default partition is the safety net and must survive')
})

test('dropped data is gone but the daily rollup survives', async (t) => {
  const db = await migrated('ret_rollup')
  t.after(() => db.end())

  const { rows: d } = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  const { rows: s } = await db.pool.query(
    `INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.example.com') RETURNING id`,
    [d[0].id]
  )
  const { rows: l } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     VALUES ($1, 'promo', 'https://x.example') RETURNING id`,
    [s[0].id]
  )

  await db.pool.query(`SELECT ensure_click_partition('2020-01-01'::date)`)
  await db.pool.query(
    `INSERT INTO click_events (link_id, occurred_at) VALUES ($1, '2020-01-15T10:00:00Z')`,
    [l[0].id]
  )
  await db.pool.query(
    `INSERT INTO click_daily (link_id, day, clicks, uniques) VALUES ($1, '2020-01-15', 1, 1)`,
    [l[0].id]
  )

  await dropExpiredPartitions(db.pool, 30)

  const { rows: events } = await db.pool.query('SELECT count(*)::int AS n FROM click_events')
  assert.equal(events[0].n, 0, 'raw events are gone')
  const { rows: daily } = await db.pool.query('SELECT clicks FROM click_daily')
  assert.equal(daily.length, 1, 'the rollup outlives the raw events')
  assert.equal(daily[0].clicks, 1)
})

test('dropExpiredPartitions rejects a nonsense window', async (t) => {
  const db = await migrated('ret_bad_input')
  t.after(() => db.end())

  await assert.rejects(() => dropExpiredPartitions(db.pool, 0), /positive integer/)
  await assert.rejects(() => dropExpiredPartitions(db.pool, -5), /positive integer/)
  await assert.rejects(() => dropExpiredPartitions(db.pool, 1.5), /positive integer/)
})
