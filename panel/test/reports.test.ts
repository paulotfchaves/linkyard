import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Pool } from 'pg'
import { buildReport, defaultRange, exportReportCsv } from '../app/lib/reports.server.ts'
import type { ReportRange } from '../app/lib/reports.server.ts'
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

const SCHEMA = 'reports_layer_test'

let db: TestDatabase

const link: Record<string, string> = {}
const domain: Record<string, string> = {}
const tag: Record<string, string> = {}

// A fixed window in the past. Every expected number below is arithmetic over
// the rows seeded here, so a relative range would make the assertions drift.
const FROM = new Date('2026-03-01T00:00:00Z')
const TO = new Date('2026-03-07T00:00:00Z')
const RANGE: ReportRange = { from: FROM, to: TO }
const COMPARED: ReportRange = { from: FROM, to: TO, compareTo: 'previous' }

async function seedDomain(apex: string, host: string): Promise<{ domainId: string; subdomainId: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    'INSERT INTO domains (apex) VALUES ($1) RETURNING id',
    [apex]
  )
  const domainId = rows[0].id
  const sub = await db.pool.query<{ id: string }>(
    'INSERT INTO subdomains (domain_id, host) VALUES ($1, $2) RETURNING id',
    [domainId, host]
  )
  return { domainId, subdomainId: sub.rows[0].id }
}

async function seedTag(name: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    'INSERT INTO tags (name) VALUES ($1) RETURNING id',
    [name]
  )
  return rows[0].id
}

async function seedLink(
  subdomainId: string,
  slug: string,
  targetUrl: string,
  tagId: string | null
): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    'INSERT INTO links (subdomain_id, slug, target_url, tag_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [subdomainId, slug, targetUrl, tagId]
  )
  return rows[0].id
}

type DailyInput = {
  clicks: number
  visitDays: number
  bots: number
  country?: Record<string, number>
  device?: Record<string, number>
  referrer?: Record<string, number>
}

async function seedDaily(linkId: string, day: string, input: DailyInput): Promise<void> {
  await db.pool.query(
    `INSERT INTO click_daily (link_id, day, clicks, uniques, bot_clicks, by_country, by_device, by_referrer)
     VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
    [
      linkId,
      day,
      input.clicks,
      input.visitDays,
      input.bots,
      JSON.stringify(input.country ?? {}),
      JSON.stringify(input.device ?? {}),
      JSON.stringify(input.referrer ?? {}),
    ]
  )
}

async function seedEvents(
  linkId: string,
  occurredAt: string,
  browser: string | null,
  count: number,
  isBot = false
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.pool.query(
      `INSERT INTO click_events (link_id, occurred_at, browser, is_bot)
       VALUES ($1, $2::timestamptz, $3, $4)`,
      [linkId, occurredAt, browser, isBot]
    )
  }
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  // db.server builds its own pool from the environment, so the test schema has
  // to reach it through the connection startup parameters rather than a SET.
  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`

  const alpha = await seedDomain('alpha.example', 'go.alpha.example')
  const bravo = await seedDomain('bravo.example', 'go.bravo.example')
  domain.alpha = alpha.domainId
  domain.bravo = bravo.domainId

  tag.launch = await seedTag('launch')
  tag.evergreen = await seedTag('evergreen')
  tag.unused = await seedTag('unused')

  link.a = await seedLink(alpha.subdomainId, 'promo', 'https://shop.example/promo', tag.launch)
  link.b = await seedLink(alpha.subdomainId, 'webinar', 'https://shop.example/webinar', tag.evergreen)
  link.c = await seedLink(bravo.subdomainId, 'deal', 'https://other.example/deal', tag.launch)
  // A link with no traffic at all: it must still count towards the size of the
  // reported set without inventing a row in the series.
  link.d = await seedLink(alpha.subdomainId, 'quiet', 'https://shop.example/quiet', null)

  await seedDaily(link.a, '2026-03-01', {
    clicks: 100,
    visitDays: 80,
    bots: 10,
    country: { BR: 60, US: 30, PT: 10 },
    device: { mobile: 34, desktop: 33, tablet: 33 },
    // Referrer keys come from a header the visitor controls, so a comma and a
    // quote in a key are exactly the input a CSV export has to survive.
    referrer: { direct: 50, 'instagram.com': 30, 'evil,site.example': 16, 'say "hi".example': 4 },
  })
  await seedDaily(link.a, '2026-03-03', {
    clicks: 50,
    visitDays: 40,
    bots: 5,
    country: { BR: 50 },
    device: { mobile: 20, desktop: 15, tablet: 15 },
    referrer: { direct: 50 },
  })
  await seedDaily(link.a, '2026-03-05', {
    clicks: 200,
    visitDays: 150,
    bots: 0,
    country: { BR: 104, US: 30, PT: 20, AR: 14, CL: 10, MX: 8, ES: 6, FR: 4, DE: 2, IT: 2 },
    device: { mobile: 60, desktop: 70, tablet: 70 },
    referrer: { direct: 100, 'instagram.com': 100 },
  })
  await seedDaily(link.b, '2026-03-02', {
    clicks: 20,
    visitDays: 18,
    bots: 2,
    country: { US: 20 },
    device: { mobile: 10, desktop: 5, tablet: 5 },
    referrer: { direct: 20 },
  })
  await seedDaily(link.c, '2026-03-04', {
    clicks: 30,
    visitDays: 25,
    bots: 3,
    country: { BR: 30 },
    device: { mobile: 10, desktop: 10, tablet: 10 },
    referrer: { 'instagram.com': 30 },
  })

  // Before the window: the comparison baseline, and proof the current window
  // does not swallow it.
  await seedDaily(link.a, '2026-02-25', {
    clicks: 200,
    visitDays: 100,
    bots: 50,
    country: { BR: 200 },
    device: { mobile: 200 },
    referrer: { direct: 200 },
  })
  // After the window.
  await seedDaily(link.a, '2026-03-09', {
    clicks: 777,
    visitDays: 777,
    bots: 777,
    country: { BR: 777 },
    device: { mobile: 777 },
    referrer: { direct: 777 },
  })

  await seedEvents(link.a, '2026-03-01T12:00:00Z', 'Chrome', 3)
  await seedEvents(link.a, '2026-03-01T12:05:00Z', 'Safari', 2)
  await seedEvents(link.a, '2026-03-01T12:10:00Z', 'Firefox', 1)
  await seedEvents(link.a, '2026-03-01T12:15:00Z', null, 1)
  // A preview fetcher that does report a browser. The exclusion has to key on
  // is_bot, not on the browser column being empty.
  await seedEvents(link.a, '2026-03-01T13:00:00Z', 'Chrome', 2, true)
  await seedEvents(link.c, '2026-03-04T10:00:00Z', 'Edge', 1)
  await seedEvents(link.b, '2026-03-07T23:30:00Z', 'Vivaldi', 1)
  await seedEvents(link.b, '2026-03-08T00:30:00Z', 'Konqueror', 1)
  await seedEvents(link.a, '2026-02-20T10:00:00Z', 'Opera', 1)
  await seedEvents(link.a, '2026-03-20T10:00:00Z', 'Opera', 1)
})

after(async () => {
  await closePool()
  await db.end()
})

describe('totals', () => {
  it('excludes bots from clicks and reports them separately', async () => {
    const report = await buildReport({}, RANGE)
    assert.equal(report.totals.clicks, 400)
    assert.equal(report.totals.visitDays, 313)
    assert.equal(report.totals.bots, 20)
    // 20 of 420 fetches were previews, so a fifth of a percent point matters.
    assert.equal(report.totals.botShare, 4.8)
  })

  it('counts the links the report covers, not only the ones with traffic', async () => {
    const report = await buildReport({}, RANGE)
    assert.equal(report.totals.links, 4, 'the silent link is still in the reported set')
    assert.equal(report.topLinks.length, 3, 'but it contributes no row to the ranking')
  })

  it('reports the range it actually covered', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.range, { from: '2026-03-01', to: '2026-03-07', days: 7 })
  })
})

describe('series', () => {
  it('emits every day in the range, including the empty ones', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.series, [
      { day: '2026-03-01', clicks: 100, visitDays: 80, bots: 10 },
      { day: '2026-03-02', clicks: 20, visitDays: 18, bots: 2 },
      { day: '2026-03-03', clicks: 50, visitDays: 40, bots: 5 },
      { day: '2026-03-04', clicks: 30, visitDays: 25, bots: 3 },
      { day: '2026-03-05', clicks: 200, visitDays: 150, bots: 0 },
      { day: '2026-03-06', clicks: 0, visitDays: 0, bots: 0 },
      { day: '2026-03-07', clicks: 0, visitDays: 0, bots: 0 },
    ])
  })

  it('leaves days outside the range out of the totals', async () => {
    const report = await buildReport({}, RANGE)
    const days = report.series.map((point) => point.day)
    assert.equal(days.includes('2026-02-25'), false)
    assert.equal(days.includes('2026-03-09'), false)
    assert.equal(report.totals.clicks, 400, '977 clicks sit just outside the window')
  })

  it('names the busiest day as the peak', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.peak, { day: '2026-03-05', clicks: 200 })
  })
})

describe('breakdowns', () => {
  it('keeps the top eight and folds the long tail into one bucket', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.byCountry, [
      { key: 'BR', label: 'BR', clicks: 244, share: 61 },
      { key: 'US', label: 'US', clicks: 80, share: 20 },
      { key: 'PT', label: 'PT', clicks: 30, share: 7.5 },
      { key: 'AR', label: 'AR', clicks: 14, share: 3.5 },
      { key: 'CL', label: 'CL', clicks: 10, share: 2.5 },
      { key: 'MX', label: 'MX', clicks: 8, share: 2 },
      { key: 'ES', label: 'ES', clicks: 6, share: 1.5 },
      { key: 'FR', label: 'FR', clicks: 4, share: 1 },
      // DE (2) and IT (2), the ninth and tenth countries.
      { key: 'other', label: 'Other', clicks: 4, share: 1 },
    ])
  })

  it('makes the shares of a breakdown add up to a hundred', async () => {
    const report = await buildReport({}, RANGE)
    for (const [name, breakdown] of [
      ['country', report.byCountry],
      ['device', report.byDevice],
      ['browser', report.byBrowser],
      ['referrer', report.byReferrer],
    ] as const) {
      const sum = breakdown.reduce((total, bucket) => total + bucket.share, 0)
      assert.ok(Math.abs(sum - 100) <= 0.1, `${name} shares add up to ${sum}`)
    }
  })

  it('splits an indivisible remainder instead of rounding every bucket up', async () => {
    // 134/133/133 of 400 rounds naively to 33.5/33.3/33.3, which is 100.1.
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.byDevice, [
      { key: 'mobile', label: 'Mobile', clicks: 134, share: 33.5 },
      { key: 'desktop', label: 'Desktop', clicks: 133, share: 33.3 },
      { key: 'tablet', label: 'Tablet', clicks: 133, share: 33.2 },
    ])
  })

  it('labels the referrer buckets a visitor never sends', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.byReferrer, [
      { key: 'direct', label: 'Direct', clicks: 220, share: 55 },
      { key: 'instagram.com', label: 'instagram.com', clicks: 160, share: 40 },
      { key: 'evil,site.example', label: 'evil,site.example', clicks: 16, share: 4 },
      { key: 'say "hi".example', label: 'say "hi".example', clicks: 4, share: 1 },
    ])
  })

  it('reads browsers from the raw events and drops the preview fetchers', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.byBrowser, [
      { key: 'Chrome', label: 'Chrome', clicks: 3, share: 33.4 },
      { key: 'Safari', label: 'Safari', clicks: 2, share: 22.2 },
      { key: 'Edge', label: 'Edge', clicks: 1, share: 11.1 },
      { key: 'Firefox', label: 'Firefox', clicks: 1, share: 11.1 },
      { key: 'Vivaldi', label: 'Vivaldi', clicks: 1, share: 11.1 },
      { key: 'unknown', label: 'Unknown', clicks: 1, share: 11.1 },
    ])
  })

  it('closes the browser window on the last day of the range, not before it', async () => {
    const report = await buildReport({ linkIds: [link.b] }, RANGE)
    assert.deepEqual(report.byBrowser, [
      { key: 'Vivaldi', label: 'Vivaldi', clicks: 1, share: 100 },
    ])
  })
})

describe('top links', () => {
  it('ranks by clicks and carries the host and slug', async () => {
    const report = await buildReport({}, RANGE)
    assert.deepEqual(report.topLinks, [
      { id: link.a, host: 'go.alpha.example', slug: 'promo', clicks: 350, share: 87.5 },
      { id: link.c, host: 'go.bravo.example', slug: 'deal', clicks: 30, share: 7.5 },
      { id: link.b, host: 'go.alpha.example', slug: 'webinar', clicks: 20, share: 5 },
    ])
  })
})

describe('comparison', () => {
  it('reports the change against the window that came before', async () => {
    const report = await buildReport({}, COMPARED)
    // 2026-02-22..2026-02-28 holds one row: 200 clicks and 100 uniques.
    assert.deepEqual(report.change, { clicks: 100, visitDays: 213 })
  })

  it('returns no change when the previous window had nothing to compare with', async () => {
    const report = await buildReport({ linkIds: [link.b] }, COMPARED)
    assert.equal(report.change, null, 'a percentage against zero is not information')
  })

  it('returns no change when no comparison was asked for', async () => {
    const report = await buildReport({}, RANGE)
    assert.equal(report.change, null)
  })
})

describe('scope', () => {
  it('reports a single link', async () => {
    const report = await buildReport({ linkIds: [link.a] }, RANGE)
    assert.equal(report.totals.clicks, 350)
    assert.equal(report.totals.visitDays, 270)
    assert.equal(report.totals.bots, 15)
    assert.equal(report.totals.links, 1)
    assert.deepEqual(report.peak, { day: '2026-03-05', clicks: 200 })
  })

  it('reports every link carrying a tag', async () => {
    const report = await buildReport({ tagId: tag.launch }, RANGE)
    assert.equal(report.totals.clicks, 380)
    assert.equal(report.totals.visitDays, 295)
    assert.equal(report.totals.links, 2)
  })

  it('reports every link under a domain', async () => {
    const report = await buildReport({ domainId: domain.bravo }, RANGE)
    assert.equal(report.totals.clicks, 30)
    assert.equal(report.totals.links, 1)
    assert.deepEqual(report.byBrowser, [{ key: 'Edge', label: 'Edge', clicks: 1, share: 100 }])
  })

  it('searches the slug and the destination', async () => {
    const bySlug = await buildReport({ search: 'webinar' }, RANGE)
    assert.equal(bySlug.totals.clicks, 20)
    assert.equal(bySlug.totals.links, 1)

    const byDestination = await buildReport({ search: 'other.example' }, RANGE)
    assert.equal(byDestination.totals.clicks, 30)
    assert.equal(byDestination.totals.links, 1)
  })

  it('composes filters instead of letting the last one win', async () => {
    const report = await buildReport({ tagId: tag.launch, domainId: domain.alpha }, RANGE)
    assert.equal(report.totals.clicks, 350, 'the launch tag minus the link on the other domain')
    assert.equal(report.totals.links, 1)
  })

  it('treats an explicitly empty link list as an empty selection', async () => {
    const report = await buildReport({ linkIds: [] }, RANGE)
    assert.equal(report.totals.clicks, 0)
    assert.equal(report.totals.links, 0)
  })

  it('returns zeros rather than failing when nothing matches', async () => {
    const report = await buildReport({ tagId: tag.unused }, COMPARED)
    assert.deepEqual(report.totals, { clicks: 0, visitDays: 0, bots: 0, botShare: 0, links: 0 })
    assert.equal(report.change, null)
    assert.equal(report.peak, null)
    assert.equal(report.series.length, 7)
    assert.deepEqual(
      report.series.map((point) => point.clicks),
      [0, 0, 0, 0, 0, 0, 0]
    )
    assert.deepEqual(report.byCountry, [])
    assert.deepEqual(report.byDevice, [])
    assert.deepEqual(report.byBrowser, [])
    assert.deepEqual(report.byReferrer, [])
    assert.deepEqual(report.topLinks, [])
  })
})

describe('csv export', () => {
  it('starts with a header and holds one row per day', async () => {
    const csv = await exportReportCsv({}, RANGE)
    const lines = csv.split('\n')
    assert.equal(lines[0], 'section,key,label,clicks,visit_days,bots,share')
    assert.equal(lines[1], 'day,2026-03-01,2026-03-01,100,80,10,')
    assert.equal(lines.filter((line) => line.startsWith('day,')).length, 7)
  })

  it('carries a row per bucket of every breakdown dimension', async () => {
    const csv = await exportReportCsv({}, RANGE)
    const sections = csv
      .split('\n')
      .slice(1)
      .map((line) => line.slice(0, line.indexOf(',')))
    assert.equal(sections.filter((s) => s === 'country').length, 9)
    assert.equal(sections.filter((s) => s === 'device').length, 3)
    assert.equal(sections.filter((s) => s === 'browser').length, 6)
    assert.equal(sections.filter((s) => s === 'referrer').length, 4)
    assert.equal(sections.filter((s) => s === 'link').length, 3)
    assert.ok(csv.includes('country,BR,BR,244,,,61.0'))
  })

  it('quotes a field holding a comma', async () => {
    const csv = await exportReportCsv({}, RANGE)
    assert.ok(
      csv.includes('referrer,"evil,site.example","evil,site.example",16,,,4.0'),
      `comma left unquoted:\n${csv}`
    )
  })

  it('escapes a quote by doubling it', async () => {
    const csv = await exportReportCsv({}, RANGE)
    assert.ok(
      csv.includes('referrer,"say ""hi"".example","say ""hi"".example",4,,,1.0'),
      `quote left unescaped:\n${csv}`
    )
  })
})

describe('default range', () => {
  it('spans the requested number of days, ending today', async () => {
    const range = defaultRange(7)
    assert.equal(range.compareTo, 'previous')
    const from = range.from.toISOString().slice(0, 10)
    const to = range.to.toISOString().slice(0, 10)
    assert.equal(to, new Date().toISOString().slice(0, 10))
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
    assert.equal(span, 6, 'seven days counted inclusively')

    const report = await buildReport({ linkIds: [] }, range)
    assert.equal(report.range.days, 7)
    assert.equal(report.series.length, 7)
  })

  it('defaults to thirty days', () => {
    const range = defaultRange()
    const span = Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000)
    assert.equal(span, 29)
  })
})
