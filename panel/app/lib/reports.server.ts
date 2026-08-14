import { query } from './db.server.ts'

// The reports layer. One link or a filtered set of them, same shape either way.
//
// Everything that spans days is read from click_daily, never from click_events.
// The raw table is partitioned, unbounded, and pruned on a retention window;
// the rollup is small and survives that purge. Scanning millions of raw rows to
// draw a 90-day chart is the exact cost this schema was built to avoid, so the
// one figure with no rollup behind it — the browser breakdown — is the only
// thing here that touches click_events, and it is bounded by the same window.
//
// Bots never reach clicks or uniques. WhatsApp, Meta, Telegram, Slack and
// Discord all fetch a link to build a preview, and a report that counts those
// as visitors is worse than no report at all: it is confidently wrong.

export type ReportScope = {
  /** Include soft-deleted links. A Trash report opts in; nothing else should. */
  includeDeleted?: boolean
  linkIds?: string[]
  domainId?: string
  tagId?: string
  search?: string
}

export type ReportRange = { from: Date; to: Date; compareTo?: 'previous' | null }

/**
 * visitDays, not uniques.
 *
 * The value is the sum of per-link, per-day distinct visitors. Summing daily
 * uniques does NOT give a period unique count — somebody who came back on three
 * days counts three times. Calling it `uniques` invites a label in the UI that
 * says something false, so the field says what it is.
 */
export type Series = Array<{ day: string; clicks: number; visitDays: number; bots: number }>

export type Breakdown = Array<{ key: string; label: string; clicks: number; share: number }>

export type Report = {
  totals: { clicks: number; visitDays: number; bots: number; botShare: number; links: number }
  /** Percent against the comparison window, or null when there is no baseline. */
  change: { clicks: number | null; visitDays: number | null } | null
  series: Series
  byCountry: Breakdown
  byDevice: Breakdown
  byBrowser: Breakdown
  byReferrer: Breakdown
  topLinks: Array<{ id: string; host: string; slug: string; clicks: number; share: number }>
  peak: { day: string; clicks: number } | null
  range: { from: string; to: string; days: number }
}

const DAY_MS = 86_400_000

// Eight buckets plus a fold. Past that a chart legend stops being readable and
// a long tail of one-click referrers crowds out the three that matter.
const MAX_BUCKETS = 8
const OTHER = 'other'
const UNKNOWN = 'unknown'
const TOP_LINKS = 8

// Keys are machine-stable and travel to the CSV; the label is the English
// fallback for the vocabulary the edge writes, which the panel may translate.
// Anything not listed is already display-ready: a country code, a host, a
// browser name.
const LABELS: Record<string, string> = {
  [OTHER]: 'Other',
  [UNKNOWN]: 'Unknown',
  direct: 'Direct',
  mobile: 'Mobile',
  desktop: 'Desktop',
  tablet: 'Tablet',
  bot: 'Bot',
}

function labelFor(key: string): string {
  return LABELS[key] ?? key
}

// Rollup days are UTC — the edge writes them from an ISO date — so a Date is
// read in UTC here too. Reading it locally would slide a late evening in
// America/Sao_Paulo into the wrong bucket and make the day totals disagree with
// the chart.
function dayString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/** Collects bound values so a fragment can be composed without counting $n by hand. */
type Binder = { values: unknown[]; bind: (value: unknown) => string }

function binder(): Binder {
  const values: unknown[] = []
  return {
    values,
    bind(value: unknown) {
      values.push(value)
      return `$${values.length}`
    },
  }
}

// Every filter is a condition on the same two aliases, so the scope composes:
// a tag and a domain narrow together rather than the last one winning.
function scopeConditions(scope: ReportScope, b: Binder): string[] {
  const conditions: string[] = []
  // A deleted link is gone from the Links page, so counting its clicks here
  // would make the two screens disagree about the same number with no way for
  // the reader to tell which is right. includeDeleted is how a Trash report
  // asks for them back.
  if (!scope.includeDeleted) conditions.push('l.deleted_at IS NULL')
  // A defined-but-empty list selects nothing. That is the literal reading of an
  // explicit selection, and guessing "empty means everything" would silently
  // report the whole installation to somebody who selected zero links.
  if (scope.linkIds) conditions.push(`l.id = ANY(${b.bind(scope.linkIds)}::uuid[])`)
  if (scope.domainId) conditions.push(`s.domain_id = ${b.bind(scope.domainId)}::uuid`)
  if (scope.tagId) conditions.push(`l.tag_id = ${b.bind(scope.tagId)}::uuid`)
  if (scope.search && scope.search.trim()) {
    const like = `%${scope.search.trim()}%`
    conditions.push(`(l.slug ILIKE ${b.bind(like)} OR l.target_url ILIKE ${b.bind(like)})`)
  }
  return conditions
}

const DAILY_FROM = `
    FROM click_daily d
    JOIN links l ON l.id = d.link_id
    JOIN subdomains s ON s.id = l.subdomain_id`

type DailyRow = { day: string; clicks: number; visit_days: number; bots: number }

// day::text rather than the driver's Date: pg would hand back a Date built in
// the process time zone, and formatting it again is one more chance to move a
// row into the neighbouring day.
async function readDaily(scope: ReportScope, from: string, to: string): Promise<DailyRow[]> {
  const b = binder()
  const where = [
    `d.day BETWEEN ${b.bind(from)}::date AND ${b.bind(to)}::date`,
    ...scopeConditions(scope, b),
  ]
  return query<DailyRow>(
    `SELECT d.day::text AS day,
            sum(d.clicks)::int AS clicks,
            sum(d.uniques)::int AS visit_days,
            sum(d.bot_clicks)::int AS bots
       ${DAILY_FROM}
      WHERE ${where.join(' AND ')}
      GROUP BY d.day
      ORDER BY d.day`,
    b.values
  )
}

type BucketRow = { key: string; clicks: number }

// The column name is interpolated and no caller value reaches it: the parameter
// is typed to three literals that exist only in this file.
type RollupColumn = 'by_country' | 'by_device' | 'by_referrer'

async function readRollup(
  scope: ReportScope,
  column: RollupColumn,
  from: string,
  to: string
): Promise<BucketRow[]> {
  const b = binder()
  const where = [
    `d.day BETWEEN ${b.bind(from)}::date AND ${b.bind(to)}::date`,
    ...scopeConditions(scope, b),
  ]
  return query<BucketRow>(
    `SELECT COALESCE(NULLIF(kv.key, ''), '${UNKNOWN}') AS key,
            sum(kv.value::bigint)::int AS clicks
       ${DAILY_FROM}
       CROSS JOIN LATERAL jsonb_each_text(d.${column}) AS kv(key, value)
      WHERE ${where.join(' AND ')}
      GROUP BY 1`,
    b.values
  )
}

// The one breakdown with no rollup column behind it. It is therefore only as
// complete as the retention window on the raw events: a range reaching past the
// purge shows the browsers of the days that survive, while every other figure
// in the report still covers the whole range.
async function readBrowsers(scope: ReportScope, from: string, to: string): Promise<BucketRow[]> {
  const b = binder()
  // The rollup keys days in UTC, so the raw window is anchored in UTC too
  // rather than in whatever time zone the database session happens to carry.
  const where = [
    `NOT e.is_bot`,
    `e.occurred_at >= (${b.bind(from)}::date::timestamp AT TIME ZONE 'UTC')`,
    `e.occurred_at < ((${b.bind(to)}::date + 1)::timestamp AT TIME ZONE 'UTC')`,
    ...scopeConditions(scope, b),
  ]
  return query<BucketRow>(
    `SELECT COALESCE(NULLIF(e.browser, ''), '${UNKNOWN}') AS key, count(*)::int AS clicks
       FROM click_events e
       JOIN links l ON l.id = e.link_id
       JOIN subdomains s ON s.id = l.subdomain_id
      WHERE ${where.join(' AND ')}
      GROUP BY 1`,
    b.values
  )
}

type TopLinkRow = { id: string; host: string; slug: string; clicks: number }

async function readTopLinks(scope: ReportScope, from: string, to: string): Promise<TopLinkRow[]> {
  const b = binder()
  const where = [
    `d.day BETWEEN ${b.bind(from)}::date AND ${b.bind(to)}::date`,
    ...scopeConditions(scope, b),
  ]
  return query<TopLinkRow>(
    `SELECT l.id::text AS id, s.host, l.slug, sum(d.clicks)::int AS clicks
       ${DAILY_FROM}
      WHERE ${where.join(' AND ')}
      GROUP BY l.id, s.host, l.slug
     HAVING sum(d.clicks) > 0
      ORDER BY clicks DESC, s.host, l.slug
      LIMIT ${TOP_LINKS}`,
    b.values
  )
}

// Counted over links, not over click_daily: this is the size of the set the
// report covers, so a link that saw no traffic in the window is still one of
// the links being reported on.
async function countLinks(scope: ReportScope): Promise<number> {
  const b = binder()
  const where = scopeConditions(scope, b)
  const rows = await query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM links l
       JOIN subdomains s ON s.id = l.subdomain_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    b.values
  )
  return rows[0]?.total ?? 0
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function byClicksThenKey(a: BucketRow, b: BucketRow): number {
  if (b.clicks !== a.clicks) return b.clicks - a.clicks
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Shares by largest remainder, in tenths of a percent.
 *
 * Rounding each bucket on its own is what makes a pie chart read 100.1%: three
 * buckets of 33.33 each round up. Handing the leftover tenths to the buckets
 * with the largest discarded fraction keeps the column adding up to exactly
 * 100.0, at the cost of one bucket landing a tenth away from its naive
 * rounding when two of them want the same tenth.
 */
function assignShares(buckets: BucketRow[]): Breakdown {
  const total = buckets.reduce((sum, bucket) => sum + bucket.clicks, 0)
  if (total <= 0) {
    return buckets.map((bucket) => ({
      key: bucket.key,
      label: labelFor(bucket.key),
      clicks: bucket.clicks,
      share: 0,
    }))
  }

  const exact = buckets.map((bucket) => (bucket.clicks * 1000) / total)
  const tenths = exact.map(Math.floor)
  let left = 1000 - tenths.reduce((sum, value) => sum + value, 0)

  const order = exact
    .map((value, index) => ({ index, remainder: value - tenths[index] }))
    .sort(
      (a, z) =>
        z.remainder - a.remainder ||
        buckets[z.index].clicks - buckets[a.index].clicks ||
        (buckets[a.index].key < buckets[z.index].key ? -1 : 1)
    )

  for (const { index } of order) {
    if (left <= 0) break
    tenths[index] += 1
    left -= 1
  }

  return buckets.map((bucket, index) => ({
    key: bucket.key,
    label: labelFor(bucket.key),
    clicks: bucket.clicks,
    share: tenths[index] / 10,
  }))
}

function toBreakdown(rows: BucketRow[]): Breakdown {
  const ranked = rows.filter((row) => row.clicks > 0).sort(byClicksThenKey)
  const head = ranked.slice(0, MAX_BUCKETS).map((row) => ({ key: row.key, clicks: row.clicks }))
  const tail = ranked.slice(MAX_BUCKETS)

  if (tail.length) {
    const folded = tail.reduce((sum, row) => sum + row.clicks, 0)
    // A dimension can legitimately contain a bucket already called "other";
    // two rows with the same key would break every consumer that maps by key.
    const existing = head.find((bucket) => bucket.key === OTHER)
    if (existing) existing.clicks += folded
    else head.push({ key: OTHER, clicks: folded })
  }

  return assignShares(head)
}

function sumDaily(rows: DailyRow[]): { clicks: number; visitDays: number; bots: number } {
  return rows.reduce(
    (totals, row) => ({
      clicks: totals.clicks + row.clicks,
      visitDays: totals.visitDays + row.visit_days,
      bots: totals.bots + row.bots,
    }),
    { clicks: 0, visitDays: 0, bots: 0 }
  )
}

function percentChange(current: number, previous: number): number {
  // Only reached with a non-zero click baseline, and in this schema a click
  // implies a unique, so a zero here is a defensive branch rather than a real
  // reading. Reporting no movement beats reporting Infinity.
  if (previous === 0) return 0
  return round1(((current - previous) / previous) * 100)
}

export async function buildReport(scope: ReportScope, range: ReportRange): Promise<Report> {
  const from = dayString(range.from)
  const to = dayString(range.to)
  if (from > to) {
    throw new RangeError(`report range ends before it starts: ${from} to ${to}`)
  }
  const days = daySpan(from, to)

  // The comparison window is the same length, ending the day before this one
  // starts, so week-on-week means the previous week and not a sliding overlap.
  const compare = range.compareTo === 'previous'
  const previousTo = shiftDay(from, -1)
  const previousFrom = shiftDay(previousTo, -(days - 1))

  const [daily, previous, countries, devices, referrers, browsers, top, links] = await Promise.all([
    readDaily(scope, from, to),
    compare ? readDaily(scope, previousFrom, previousTo) : Promise.resolve([]),
    readRollup(scope, 'by_country', from, to),
    readRollup(scope, 'by_device', from, to),
    readRollup(scope, 'by_referrer', from, to),
    readBrowsers(scope, from, to),
    readTopLinks(scope, from, to),
    countLinks(scope),
  ])

  const byDay = new Map(daily.map((row) => [row.day, row]))
  const series: Series = []
  for (let i = 0; i < days; i++) {
    const day = shiftDay(from, i)
    const row = byDay.get(day)
    series.push({
      day,
      clicks: row?.clicks ?? 0,
      visitDays: row?.visit_days ?? 0,
      bots: row?.bots ?? 0,
    })
  }

  // uniques is the sum of per-link, per-day distinct visitors. The rollup
  // cannot dedupe one person across two links or two days, and rebuilding that
  // from the raw events is exactly the scan this layer refuses to run.
  const totals = sumDaily(daily)
  const traffic = totals.clicks + totals.bots

  const previousTotals = sumDaily(previous)
  // Each metric is gated on its OWN baseline. Gating both on clicks let a
  // uniques baseline of zero through, where percentChange has nothing to divide
  // by and returns 0 — a number that reads as "no change" when the truth is
  // "no comparison is possible".
  const changeClicks =
    compare && previousTotals.clicks > 0
      ? percentChange(totals.clicks, previousTotals.clicks)
      : null
  const changeVisitDays =
    compare && previousTotals.visitDays > 0
      ? percentChange(totals.visitDays, previousTotals.visitDays)
      : null
  // An object of nulls says "there is a comparison, and it is nothing", which is
  // not what happened. No baseline at all means no comparison object.
  const change =
    changeClicks === null && changeVisitDays === null
      ? null
      : { clicks: changeClicks, visitDays: changeVisitDays }

  const peak = series.reduce<{ day: string; clicks: number } | null>((best, point) => {
    if (point.clicks <= 0) return best
    // Strictly greater, so a tie keeps the earlier day.
    return !best || point.clicks > best.clicks ? { day: point.day, clicks: point.clicks } : best
  }, null)

  return {
    totals: {
      clicks: totals.clicks,
      visitDays: totals.visitDays,
      bots: totals.bots,
      botShare: traffic > 0 ? round1((totals.bots / traffic) * 100) : 0,
      links,
    },
    change,
    series,
    byCountry: toBreakdown(countries),
    byDevice: toBreakdown(devices),
    byBrowser: toBreakdown(browsers),
    byReferrer: toBreakdown(referrers),
    // Shares are of the report total and the list is truncated, so these do not
    // add up to 100 — unlike a breakdown, which folds its tail.
    topLinks: top.map((row) => ({
      id: row.id,
      host: row.host,
      slug: row.slug,
      clicks: row.clicks,
      share: totals.clicks > 0 ? round1((row.clicks / totals.clicks) * 100) : 0,
    })),
    peak,
    range: { from, to, days },
  }
}

// RFC 4180: quote a field that carries a delimiter, a quote, or a newline, and
// escape a quote by doubling it. Rollup keys are referrer hosts and country
// codes that arrive from request headers, so a key holding a comma is untrusted
// input, not a hypothetical.
function csvField(value: string | number): string {
  const raw = String(value)

  // Two different escapes, for two different readers.
  //
  // RFC 4180 quoting keeps a comma from becoming a column. It does nothing
  // about a spreadsheet, which treats a leading =, +, - or @ as the start of a
  // formula and will happily execute it when the file is opened. A referrer
  // host is attacker-supplied and lands in this file, so the guard applies to
  // every cell rather than to the ones that look risky.
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw

  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export async function exportReportCsv(scope: ReportScope, range: ReportRange): Promise<string> {
  const report = await buildReport(scope, range)

  const rows: string[][] = [['section', 'key', 'label', 'clicks', 'visit_days', 'bots', 'share']]

  for (const point of report.series) {
    rows.push([
      'day',
      point.day,
      point.day,
      String(point.clicks),
      String(point.visitDays),
      String(point.bots),
      '',
    ])
  }

  const dimensions: Array<[string, Breakdown]> = [
    ['country', report.byCountry],
    ['device', report.byDevice],
    ['browser', report.byBrowser],
    ['referrer', report.byReferrer],
  ]
  for (const [section, breakdown] of dimensions) {
    for (const bucket of breakdown) {
      rows.push([
        section,
        bucket.key,
        bucket.label,
        String(bucket.clicks),
        '',
        '',
        bucket.share.toFixed(1),
      ])
    }
  }

  for (const item of report.topLinks) {
    rows.push([
      'link',
      item.id,
      `${item.host}/${item.slug}`,
      String(item.clicks),
      '',
      '',
      item.share.toFixed(1),
    ])
  }

  return rows.map((row) => row.map(csvField).join(',')).join('\n')
}

/**
 * The window the panel opens on: the last `days` days counted inclusively, with
 * the previous window as the baseline.
 */
export function defaultRange(days = 30): ReportRange {
  if (!Number.isInteger(days) || days < 1) {
    throw new TypeError('days must be a positive integer')
  }
  const to = new Date()
  const from = new Date(to.getTime() - (days - 1) * DAY_MS)
  return { from, to, compareTo: 'previous' }
}
