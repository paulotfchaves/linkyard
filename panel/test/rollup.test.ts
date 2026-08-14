import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Pool } from 'pg'
import { rollupDay, rollupRange, rollupRecent } from '../app/lib/rollup.server.ts'
import { buildReport } from '../app/lib/reports.server.ts'
import { closePool } from '../app/lib/db.server.ts'

// The db workspace is plain ESM with no type declarations and the panel's
// tsconfig does not compile JavaScript. A computed specifier keeps `tsc
// --noEmit` from typing a module it cannot see.
const load = (path: string) => import(new URL(path, import.meta.url).href)

const { freshDatabase, TEST_URL } = (await load('../../db/test-support/helpers.mjs')) as {
  freshDatabase: (schemaName: string) => Promise<TestDatabase>
  TEST_URL: string
}
const { migrate } = (await load('../../db/migrate.mjs')) as {
  migrate: (pool: Pool, dir?: string) => Promise<string[]>
}

type TestDatabase = { pool: Pool; schemaName: string; end: () => Promise<void> }

const SCHEMA = 'rollup_layer_test'

let db: TestDatabase

const link: Record<string, string> = {}

// A link id with no row behind it. click_events carries no foreign key — one
// would cost an index write on the hottest insert path in the product — so a
// hard-deleted link leaves its events behind, and the fold has to survive them.
const ORPHAN = '00000000-0000-4000-8000-0000000000ff'

const HOUR_MS = 3_600_000

type EventInput = {
  ip?: string | null
  country?: string | null
  device?: string | null
  referrer?: string | null
  bot?: boolean
}

async function seedLink(subdomainId: string, slug: string, deleted = false): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO links (subdomain_id, slug, target_url, deleted_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [subdomainId, slug, `https://shop.example/${slug}`, deleted ? new Date() : null]
  )
  return rows[0].id
}

async function seedEvents(
  linkId: string,
  occurredAt: string | Date,
  count: number,
  input: EventInput = {}
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.pool.query(
      `INSERT INTO click_events (link_id, occurred_at, ip_hash, country, device, referrer_host, is_bot)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7)`,
      [
        linkId,
        occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt,
        input.ip ? Buffer.from(input.ip) : null,
        input.country ?? null,
        input.device ?? null,
        input.referrer ?? null,
        input.bot ?? false,
      ]
    )
  }
}

type DailyRow = {
  clicks: number
  uniques: number
  bot_clicks: number
  by_country: Record<string, number>
  by_device: Record<string, number>
  by_referrer: Record<string, number>
}

async function readDaily(linkId: string, day: string): Promise<DailyRow | null> {
  const { rows } = await db.pool.query<DailyRow>(
    `SELECT clicks, uniques, bot_clicks, by_country, by_device, by_referrer
       FROM click_daily WHERE link_id = $1 AND day = $2::date`,
    [linkId, day]
  )
  return rows[0] ?? null
}

async function totalClicks(linkId: string): Promise<number> {
  const { rows } = await db.pool.query<{ total: number }>(
    'SELECT COALESCE(sum(clicks), 0)::int AS total FROM click_daily WHERE link_id = $1',
    [linkId]
  )
  return rows[0].total
}

/** Counts straight off the raw table, so the fold is checked against something it did not write. */
async function rawTotals(from: string, to: string): Promise<{ clicks: number; bots: number }> {
  const { rows } = await db.pool.query<{ clicks: number; bots: number }>(
    `SELECT count(*) FILTER (WHERE NOT e.is_bot)::int AS clicks,
            count(*) FILTER (WHERE e.is_bot)::int AS bots
       FROM click_events e
       JOIN links l ON l.id = e.link_id
      WHERE l.deleted_at IS NULL
        AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz`,
    [from, to]
  )
  return rows[0]
}

async function rawBuckets(
  column: 'country' | 'device' | 'referrer_host',
  fallback: string,
  from: string,
  to: string
): Promise<Record<string, number>> {
  const { rows } = await db.pool.query<{ key: string; clicks: number }>(
    `SELECT COALESCE(NULLIF(e.${column}, ''), $3) AS key, count(*)::int AS clicks
       FROM click_events e
       JOIN links l ON l.id = e.link_id
      WHERE NOT e.is_bot AND l.deleted_at IS NULL
        AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz
      GROUP BY 1`,
    [from, to, fallback]
  )
  return Object.fromEntries(rows.map((row) => [row.key, row.clicks]))
}

function breakdownToMap(
  breakdown: Array<{ key: string; clicks: number }>
): Record<string, number> {
  return Object.fromEntries(breakdown.map((bucket) => [bucket.key, bucket.clicks]))
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  // db.server builds its own pool from the environment, so the test schema has
  // to reach it through the connection startup parameters rather than a SET.
  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`

  const { rows: domainRows } = await db.pool.query<{ id: string }>(
    "INSERT INTO domains (apex) VALUES ('alpha.example') RETURNING id"
  )
  const { rows: subRows } = await db.pool.query<{ id: string }>(
    "INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.alpha.example') RETURNING id",
    [domainRows[0].id]
  )
  const subdomainId = subRows[0].id

  link.a = await seedLink(subdomainId, 'promo')
  link.b = await seedLink(subdomainId, 'webinar')
  link.gone = await seedLink(subdomainId, 'legacy', true)
  link.tz = await seedLink(subdomainId, 'tz')
  link.late = await seedLink(subdomainId, 'late')
  link.purged = await seedLink(subdomainId, 'purged')
  link.recent = await seedLink(subdomainId, 'recent')
  link.older = await seedLink(subdomainId, 'older')

  // 2026-03-01: two visitors, six human fetches, two previews.
  await seedEvents(link.a, '2026-03-01T12:00:00Z', 3, {
    ip: 'visitor-a',
    country: 'BR',
    device: 'mobile',
    referrer: 'instagram.com',
  })
  await seedEvents(link.a, '2026-03-01T13:00:00Z', 2, {
    ip: 'visitor-b',
    country: 'US',
    device: 'desktop',
  })
  // Nothing known about this one: no hash, no country, no device, no referrer.
  await seedEvents(link.a, '2026-03-01T14:00:00Z', 1)
  await seedEvents(link.a, '2026-03-01T15:00:00Z', 2, {
    ip: 'preview-bot',
    country: 'BR',
    device: 'bot',
    bot: true,
  })

  // 2026-03-02: a day that saw nothing but a link preview.
  await seedEvents(link.a, '2026-03-02T15:00:00Z', 1, {
    ip: 'preview-bot',
    country: 'US',
    device: 'bot',
    bot: true,
  })

  // 2026-03-03: two visitors, two fetches each.
  await seedEvents(link.b, '2026-03-03T09:00:00Z', 2, {
    ip: 'visitor-c',
    country: 'PT',
    device: 'desktop',
  })
  await seedEvents(link.b, '2026-03-03T09:30:00Z', 2, {
    ip: 'visitor-d',
    country: 'PT',
    device: 'desktop',
  })

  // 2026-03-04: traffic on a link that has since been sent to the trash.
  await seedEvents(link.gone, '2026-03-04T10:00:00Z', 5, {
    ip: 'visitor-e',
    country: 'BR',
    device: 'mobile',
    referrer: 'facebook.com',
  })

  // 2026-03-05: events whose link was hard-deleted.
  await seedEvents(ORPHAN, '2026-03-05T10:00:00Z', 7, { ip: 'visitor-f', country: 'BR' })

  // Late evening in America/Bogota, already the next day in UTC.
  await seedEvents(link.tz, '2026-03-06T22:00:00-05:00', 1, {
    ip: 'visitor-g',
    country: 'BR',
    device: 'mobile',
  })

  await seedEvents(link.late, '2026-03-08T10:00:00Z', 2, { ip: 'visitor-h', country: 'BR' })
  await seedEvents(link.purged, '2026-03-09T10:00:00Z', 2, { ip: 'visitor-i', country: 'BR' })
})

after(async () => {
  await closePool()
  await db.end()
})

describe('rollupDay', () => {
  it('folds a day of raw events into one row per link', async () => {
    await rollupDay(new Date('2026-03-01T00:00:00Z'))
    const row = await readDaily(link.a, '2026-03-01')
    assert.ok(row, 'the day produced no rollup row')
    assert.equal(row.clicks, 6)
    assert.equal(row.bot_clicks, 2)
  })

  it('reports what it folded', async () => {
    const result = await rollupDay(new Date('2026-03-03T00:00:00Z'))
    assert.deepEqual(result, { links: 1, clicks: 4 })
  })

  it('does not double anything when the same day is folded twice', async () => {
    await rollupDay(new Date('2026-03-01T00:00:00Z'))
    const once = await readDaily(link.a, '2026-03-01')
    await rollupDay(new Date('2026-03-01T00:00:00Z'))
    const twice = await readDaily(link.a, '2026-03-01')
    assert.deepEqual(twice, once)
  })

  it('recomputes rather than increments, so a late event lands exactly once', async () => {
    const first = await rollupDay(new Date('2026-03-08T00:00:00Z'))
    assert.deepEqual(first, { links: 1, clicks: 2 })

    // The edge writes the event after the day was already folded — a retry, a
    // queued insert, a clock that was behind.
    await seedEvents(link.late, '2026-03-08T23:00:00Z', 1, { ip: 'visitor-j', country: 'BR' })

    const second = await rollupDay(new Date('2026-03-08T00:00:00Z'))
    assert.deepEqual(second, { links: 1, clicks: 3 })
    const row = await readDaily(link.late, '2026-03-08')
    assert.equal(row?.clicks, 3, 'an increment would have produced five')
    assert.equal(row?.uniques, 2)
  })

  it('counts previews as bots and keeps them out of clicks and uniques', async () => {
    await rollupDay(new Date('2026-03-02T00:00:00Z'))
    const row = await readDaily(link.a, '2026-03-02')
    assert.ok(row, 'a bot-only day still deserves a row: the bot share is a number')
    assert.equal(row.clicks, 0)
    assert.equal(row.uniques, 0)
    assert.equal(row.bot_clicks, 1)
    assert.deepEqual(row.by_country, {}, 'a preview is not a visit from the United States')
  })

  it('keeps bots out of the breakdown buckets so they add up to clicks', async () => {
    await rollupDay(new Date('2026-03-01T00:00:00Z'))
    const row = await readDaily(link.a, '2026-03-01')
    assert.ok(row)
    for (const [name, bucket] of [
      ['country', row.by_country],
      ['device', row.by_device],
      ['referrer', row.by_referrer],
    ] as const) {
      const sum = Object.values(bucket).reduce((total, value) => total + value, 0)
      assert.equal(sum, row.clicks, `${name} buckets add up to ${sum}, not ${row.clicks}`)
    }
  })

  it('counts a returning visitor once and an unattributable fetch not at all', async () => {
    await rollupDay(new Date('2026-03-01T00:00:00Z'))
    const row = await readDaily(link.a, '2026-03-01')
    // Six fetches: three from one hash, two from another, one with no hash.
    assert.equal(row?.clicks, 6)
    assert.equal(row?.uniques, 2, 'a fetch with no hash belongs to no visitor')
  })

  it('names the empty dimensions instead of dropping them', async () => {
    await rollupDay(new Date('2026-03-01T00:00:00Z'))
    const row = await readDaily(link.a, '2026-03-01')
    assert.deepEqual(row?.by_country, { BR: 3, US: 2, unknown: 1 })
    assert.deepEqual(row?.by_device, { mobile: 3, desktop: 2, unknown: 1 })
    // No referrer header is not an unknown referrer: the visitor arrived direct.
    assert.deepEqual(row?.by_referrer, { 'instagram.com': 3, direct: 3 })
  })

  it('writes nothing for a day that saw no traffic', async () => {
    const result = await rollupDay(new Date('2026-03-20T00:00:00Z'))
    assert.deepEqual(result, { links: 0, clicks: 0 })
    const { rows } = await db.pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM click_daily WHERE day = '2026-03-20'::date"
    )
    assert.equal(rows[0].total, 0)
  })

  it('leaves an existing rollup standing after the raw events are purged', async () => {
    await rollupDay(new Date('2026-03-09T00:00:00Z'))
    assert.equal((await readDaily(link.purged, '2026-03-09'))?.clicks, 2)

    // Retention drops the partition; the rollup is what survives it.
    await db.pool.query("DELETE FROM click_events WHERE link_id = $1", [link.purged])

    const result = await rollupDay(new Date('2026-03-09T00:00:00Z'))
    assert.deepEqual(result, { links: 0, clicks: 0 })
    assert.equal(
      (await readDaily(link.purged, '2026-03-09'))?.clicks,
      2,
      'a re-run over purged events must not zero the history'
    )
  })

  it('skips events whose link no longer exists instead of failing', async () => {
    const result = await rollupDay(new Date('2026-03-05T00:00:00Z'))
    assert.deepEqual(result, { links: 0, clicks: 0 })
    const { rows } = await db.pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM click_daily WHERE link_id = $1',
      [ORPHAN]
    )
    assert.equal(rows[0].total, 0)
  })

  it('folds a link in the trash, and lets the report decide whether to show it', async () => {
    await rollupDay(new Date('2026-03-04T00:00:00Z'))
    assert.equal((await readDaily(link.gone, '2026-03-04'))?.clicks, 5)

    const range = { from: new Date('2026-03-04T00:00:00Z'), to: new Date('2026-03-04T00:00:00Z') }
    const visible = await buildReport({ linkIds: [link.gone] }, range)
    assert.equal(visible.totals.clicks, 0, 'the links page hides it, so the report does too')

    const trash = await buildReport({ linkIds: [link.gone], includeDeleted: true }, range)
    assert.equal(trash.totals.clicks, 5, 'the history is still there for whoever asks for it')
  })

  it('buckets a click by its UTC day, not by the session time zone', async () => {
    await rollupDay(new Date('2026-03-06T00:00:00Z'))
    assert.equal(await readDaily(link.tz, '2026-03-06'), null)

    await rollupDay(new Date('2026-03-07T00:00:00Z'))
    assert.equal((await readDaily(link.tz, '2026-03-07'))?.clicks, 1)
  })
})

describe('rollupRange', () => {
  it('folds every day in the span and reports the days it covered', async () => {
    const result = await rollupRange(
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-03T00:00:00Z')
    )
    assert.deepEqual(result, { days: 3, clicks: 10 })
    assert.equal((await readDaily(link.a, '2026-03-01'))?.clicks, 6)
    assert.equal((await readDaily(link.a, '2026-03-02'))?.bot_clicks, 1)
    assert.equal((await readDaily(link.b, '2026-03-03'))?.clicks, 4)
  })

  it('refuses a range that ends before it starts', async () => {
    await assert.rejects(
      () => rollupRange(new Date('2026-03-05T00:00:00Z'), new Date('2026-03-01T00:00:00Z')),
      RangeError
    )
  })
})

describe('rollupRecent', () => {
  it('folds whole days, so a short window cannot shrink a day it only half covers', async () => {
    const now = Date.now()
    await seedEvents(link.recent, new Date(now - 90 * 60_000), 2, { ip: 'visitor-k', country: 'BR' })
    await seedEvents(link.recent, new Date(now - 60_000), 3, { ip: 'visitor-l', country: 'BR' })

    await rollupRecent(1)

    // A window taken literally would have folded the last hour and overwritten
    // the day with 3, losing the two clicks from ninety minutes ago.
    assert.equal(await totalClicks(link.recent), 5)
  })

  it('reaches back far enough by default to catch a run that was missed', async () => {
    await seedEvents(link.older, new Date(Date.now() - 40 * HOUR_MS), 1, {
      ip: 'visitor-m',
      country: 'BR',
    })

    await rollupRecent(1)
    assert.equal(await totalClicks(link.older), 0, 'an hour ago does not reach yesterday')

    await rollupRecent()
    assert.equal(await totalClicks(link.older), 1)
  })
})

describe('agreement with the report layer', () => {
  const FROM = '2026-03-01T00:00:00Z'
  const TO = '2026-03-06T00:00:00Z'
  const range = { from: new Date(FROM), to: new Date('2026-03-05T00:00:00Z') }

  it('gives the report the same totals the raw events hold', async () => {
    await rollupRange(range.from, range.to)
    const report = await buildReport({}, range)
    const raw = await rawTotals(FROM, TO)

    assert.equal(report.totals.clicks, raw.clicks)
    assert.equal(report.totals.bots, raw.bots)
    assert.equal(report.totals.clicks, 10, 'six on the first day, four on the third')
    assert.equal(report.totals.visitDays, 4)
  })

  it('gives the report the same breakdowns the raw events hold', async () => {
    await rollupRange(range.from, range.to)
    const report = await buildReport({}, range)

    assert.deepEqual(
      breakdownToMap(report.byCountry),
      await rawBuckets('country', 'unknown', FROM, TO)
    )
    assert.deepEqual(
      breakdownToMap(report.byDevice),
      await rawBuckets('device', 'unknown', FROM, TO)
    )
    assert.deepEqual(
      breakdownToMap(report.byReferrer),
      await rawBuckets('referrer_host', 'direct', FROM, TO)
    )
  })
})
