import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { seedDemo, DEMO_PASSWORD, WEEKDAY_FACTOR, shapeWeekday } from '../seed/demo.ts'
import { verifyPassword } from '../app/lib/password.server.ts'

// The db workspace is plain ESM with no type declarations and the panel's
// tsconfig does not compile JavaScript. A computed specifier keeps `tsc
// --noEmit` from typing a module it cannot see, while the local casts keep this
// file's own code fully checked.
type TestDatabase = { pool: Pool; schemaName: string; end: () => Promise<void> }
const load = (path: string) => import(new URL(path, import.meta.url).href)

const { freshDatabase } = (await load('../../db/test-support/helpers.mjs')) as {
  freshDatabase: (schemaName: string) => Promise<TestDatabase>
}
const { migrate } = (await load('../../db/migrate.mjs')) as {
  migrate: (pool: Pool, dir?: string) => Promise<string[]>
}

async function migrated(schemaName: string): Promise<TestDatabase> {
  const db = await freshDatabase(schemaName)
  await migrate(db.pool)
  return db
}

const COUNTED_TABLES = [
  'users',
  'domains',
  'subdomains',
  'tags',
  'links',
  'click_events',
  'click_daily',
] as const

async function snapshot(pool: Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of COUNTED_TABLES) {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
    out[table] = rows[0].n
  }
  return out
}

const db = await migrated('panel_seed_demo')
after(() => db.end())
const counts = await seedDemo(db.pool)

test('seedDemo fills an empty database with an account that looks used', async () => {
  assert.equal(counts.users, 3)
  assert.equal(counts.domains, 2)
  assert.equal(counts.subdomains, 3)
  assert.equal(counts.links, 40)
  assert.ok(counts.clicks > 10_000, `a demo needs real volume, got ${counts.clicks}`)

  const rows = await snapshot(db.pool)
  assert.equal(rows.users, counts.users)
  assert.equal(rows.domains, counts.domains)
  assert.equal(rows.subdomains, counts.subdomains)
  assert.equal(rows.links, counts.links)
  assert.equal(rows.click_events, counts.clicks, 'the reported count is the count on disk')
  assert.equal(rows.tags, 5)

  const { rows: roles } = await db.pool.query<{ role: string }>(
    'SELECT role FROM users ORDER BY role'
  )
  assert.deepEqual(
    roles.map((r) => r.role),
    ['editor', 'owner', 'viewer']
  )

  const { rows: mix } = await db.pool.query<{
    pinned: number
    expired: number
    paused: number
    live: number
  }>(
    `SELECT count(*) FILTER (WHERE is_pinned)::int AS pinned,
            count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now())::int AS expired,
            count(*) FILTER (WHERE NOT active)::int AS paused,
            count(*) FILTER (WHERE active AND (expires_at IS NULL OR expires_at > now()))::int AS live
       FROM links`
  )
  assert.equal(mix[0].pinned, 3)
  assert.equal(mix[0].expired, 2)
  assert.ok(mix[0].paused >= 3 && mix[0].paused <= 8, `paused: ${mix[0].paused}`)
  assert.ok(mix[0].live >= 30, `most links must be live, got ${mix[0].live}`)

  const { rows: tagged } = await db.pool.query<{ tag_id: string | null; n: number }>(
    'SELECT tag_id, count(*)::int AS n FROM links GROUP BY tag_id ORDER BY n DESC'
  )
  assert.equal(tagged.length, 5, 'every one of the five tags is in use')
  assert.ok(
    tagged.every((t) => t.tag_id !== null && t.n >= 5),
    'no tag is decorative'
  )

  const { rows: perSub } = await db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM links GROUP BY subdomain_id'
  )
  assert.equal(perSub.length, 3, 'all three subdomains carry links')
})

test('seedDemo is idempotent', async () => {
  const before = await snapshot(db.pool)
  const second = await seedDemo(db.pool)
  const afterRerun = await snapshot(db.pool)

  assert.deepEqual(afterRerun, before, 'a second run must not double anything')
  assert.deepEqual(second, counts, 'the same dataset reports the same counts')
})

test('the daily rollup agrees with the events it came from', async () => {
  const { rows: mismatched } = await db.pool.query<{
    link_id: string
    day: string
    rolled: number | null
    counted: number | null
    rolled_bots: number | null
    counted_bots: number | null
  }>(
    `WITH counted AS (
       SELECT link_id,
              (occurred_at AT TIME ZONE 'UTC')::date AS day,
              count(*) FILTER (WHERE NOT is_bot)::int AS clicks,
              count(*) FILTER (WHERE is_bot)::int AS bots,
              count(DISTINCT ip_hash) FILTER (WHERE NOT is_bot)::int AS uniques
         FROM click_events
        GROUP BY 1, 2
     )
     SELECT coalesce(d.link_id, c.link_id) AS link_id,
            to_char(coalesce(d.day, c.day), 'YYYY-MM-DD') AS day,
            d.clicks AS rolled, c.clicks AS counted,
            d.bot_clicks AS rolled_bots, c.bots AS counted_bots
       FROM click_daily d
       FULL JOIN counted c ON c.link_id = d.link_id AND c.day = d.day
      WHERE d.clicks IS DISTINCT FROM c.clicks
         OR d.bot_clicks IS DISTINCT FROM c.bots
         OR d.uniques IS DISTINCT FROM c.uniques`
  )
  assert.deepEqual(mismatched, [], 'click_daily must equal the events it summarises')

  const { rows: totals } = await db.pool.query<{ clicks: number; bots: number }>(
    'SELECT sum(clicks)::int AS clicks, sum(bot_clicks)::int AS bots FROM click_daily'
  )
  assert.equal(totals[0].clicks + totals[0].bots, counts.clicks)
  assert.ok(totals[0].bots > 0, 'bot traffic is recorded, never dropped')

  // The breakdowns are the panel's only source for "where did this come from",
  // so a breakdown that does not add up to the click count is a silent lie.
  const { rows: sums } = await db.pool.query<{ off: number }>(
    `SELECT count(*)::int AS off FROM click_daily d
      WHERE (SELECT sum(value::int) FROM jsonb_each_text(d.by_country)) <> d.clicks
         OR (SELECT sum(value::int) FROM jsonb_each_text(d.by_device)) <> d.clicks
         OR (SELECT sum(value::int) FROM jsonb_each_text(d.by_referrer)) <> d.clicks`
  )
  assert.equal(sums[0].off, 0, 'every breakdown totals the human click count')

  const { rows: bad } = await db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM click_daily WHERE uniques > clicks OR clicks < 0'
  )
  assert.equal(bad[0].n, 0)
})

test('every month of history has its own partition', async () => {
  const { rows: stranded } = await db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM click_events_default'
  )
  assert.equal(stranded[0].n, 0, 'no event may land in the catch-all partition')

  const { rows: months } = await db.pool.query<{ month: string }>(
    `SELECT DISTINCT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY_MM') AS month
       FROM click_events ORDER BY month`
  )
  assert.ok(months.length >= 3, `90 days spans at least three months, got ${months.length}`)

  const { rows: partitions } = await db.pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'click_events_2%'`,
    [db.schemaName]
  )
  const present = new Set(partitions.map((p) => p.relname))
  for (const { month } of months) {
    assert.ok(present.has(`click_events_${month}`), `missing partition for ${month}`)
  }
})

// Column by column rather than a spot check: the demo database is published, so
// the interesting failure is the field nobody thought to look at.
const SCANNED: Record<string, string[]> = {
  users: ['username', 'email', 'timezone', 'locale'],
  domains: ['apex', 'dns_zone_id', 'provider_account', 'root_target'],
  subdomains: ['host', 'infra_host_id', 'record_value', 'root_target', 'fallback_url'],
  tags: ['name', 'description'],
  links: ['slug', 'target_url', 'utm_source', 'utm_campaign', 'note', 'fallback_url'],
  click_events: ['country', 'region', 'city', 'device', 'os', 'browser', 'language', 'bot_kind'],
}

const HOST_SCANNED: Record<string, string[]> = {
  domains: ['apex', 'root_target'],
  subdomains: ['host', 'record_value', 'fallback_url', 'root_target'],
  links: ['target_url', 'fallback_url'],
  click_events: ['referrer_host', 'referrer_full', 'final_url'],
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const LONG_DIGITS_RE = /\d{9,}/
const PHONE_RE = /\+\d[\d\s().-]{7,}\d/

function reservedHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'example.com' || h.endsWith('.example.com') || h.endsWith('.example')
}

async function distinctValues(pool: Pool, table: string, column: string): Promise<string[]> {
  const { rows } = await pool.query<{ v: string }>(
    `SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`
  )
  return rows.map((r) => r.v)
}

test('the demo carries no personal identifier and points at no real host', async () => {
  for (const [table, columns] of Object.entries(SCANNED)) {
    for (const column of columns) {
      for (const value of await distinctValues(db.pool, table, column)) {
        const where = `${table}.${column} = ${value}`
        assert.ok(!LONG_DIGITS_RE.test(value), `looks like an id or phone number: ${where}`)
        assert.ok(!PHONE_RE.test(value), `looks like a phone number: ${where}`)
        const email = EMAIL_RE.exec(value)
        if (email) {
          const domain = email[0].split('@')[1]
          assert.ok(reservedHost(domain), `email outside the reserved domains: ${where}`)
        }
      }
    }
  }

  for (const [table, columns] of Object.entries(HOST_SCANNED)) {
    for (const column of columns) {
      for (const value of await distinctValues(db.pool, table, column)) {
        const host = value.includes('://') ? new URL(value).hostname : value
        assert.ok(reservedHost(host), `${table}.${column} points at a real host: ${value}`)
      }
    }
  }

  // The column exists to keep an address out of the database. A demo that wrote
  // something readable into it would teach the opposite lesson.
  const { rows } = await db.pool.query<{ n: number; len: number }>(
    `SELECT count(*)::int AS n, max(octet_length(ip_hash))::int AS len
       FROM click_events WHERE ip_hash IS NOT NULL`
  )
  assert.equal(rows[0].n, counts.clicks)
  assert.equal(rows[0].len, 32, 'ip_hash is a digest, not an address')
})

test('the published password opens every demo account, and is never stored', async () => {
  const { rows } = await db.pool.query<{ email: string; password_hash: string }>(
    'SELECT email, password_hash FROM users'
  )
  assert.equal(rows.length, 3)
  for (const user of rows) {
    assert.ok(!user.password_hash.includes(DEMO_PASSWORD), `plaintext leaked for ${user.email}`)
    assert.match(user.password_hash, /^\$[a-z0-9]/, 'a modular-crypt digest, not a home-made one')
    // Against the panel's own verifier: a demo whose documented password does
    // not open the account is the first thing a visitor sees fail.
    assert.equal(await verifyPassword(user.password_hash, DEMO_PASSWORD), true, user.email)
    assert.equal(await verifyPassword(user.password_hash, 'not-the-demo-password'), false)
  }
})

test('the launch reads as a spike whichever weekday it lands on', () => {
  // The test below measures the one peak today's date happens to produce. This
  // one measures every peak the seed can produce, because the defect it guards
  // against was invisible on most days: with the weekly rhythm left undamped, a
  // Monday peak against a Tuesday tail came to exactly 1.5 — level bars, a
  // chart that reads as a step change — while a Friday peak came to 3.0 and
  // looked perfect. Nothing in the data explained the difference; the calendar
  // did.
  const PEAK = 8
  const TAIL = 5

  // The seed forces the peak onto a weekday, so Sunday and Saturday are not
  // candidates — but their factors still matter, as the day after a Friday peak.
  for (let day = 1; day <= 5; day += 1) {
    const next = (day + 1) % 7
    const peak = PEAK * shapeWeekday(WEEKDAY_FACTOR[day], PEAK)
    const tail = TAIL * shapeWeekday(WEEKDAY_FACTOR[next], TAIL)

    assert.ok(
      peak > tail * 1.5,
      `a peak on weekday ${day} must stand above its tail: ${peak.toFixed(2)} vs ${tail.toFixed(2)}`
    )
  }
})

test('a quiet day keeps its full weekly rhythm', () => {
  // The damping applies to launch days only. Flattening every day would erase
  // the weekday/weekend contrast the chart is also meant to show.
  for (let day = 0; day <= 6; day += 1) {
    assert.equal(shapeWeekday(WEEKDAY_FACTOR[day], 1), WEEKDAY_FACTOR[day])
  }
})

test('traffic has weekday peaks, weekend troughs and one launch spike', async () => {
  const { rows } = await db.pool.query<{ day: string; dow: number; total: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day,
            extract(isodow FROM day)::int AS dow,
            (sum(clicks) + sum(bot_clicks))::int AS total
       FROM click_daily GROUP BY day ORDER BY day`
  )
  assert.ok(rows.length >= 85, `90 days of history, got ${rows.length}`)

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  const totals = rows.map((r) => r.total)
  const peak = Math.max(...totals)
  const peakIndex = totals.indexOf(peak)

  // Baseline means the fortnight before the launch, not the whole window: the
  // account grows over 90 days, so measuring the spike against the median of a
  // quarter that includes its own quiet beginning overstates it. Weekdays only,
  // and the ramp day immediately before the peak is left out of its own
  // baseline.
  const trailing = rows
    .slice(Math.max(0, peakIndex - 10), Math.max(0, peakIndex - 1))
    .filter((r) => r.dow <= 5)
    .map((r) => r.total)
  assert.ok(trailing.length >= 4, 'the spike must sit far enough into the window to be measured')

  const baseline = median(trailing)
  const ratio = peak / baseline
  assert.ok(ratio >= 6 && ratio <= 11, `launch spike should be around 8x baseline, got ${ratio}`)

  // Median, not mean: it survives the spike days without excluding them by hand.
  const weekdays = median(rows.filter((r) => r.dow <= 5).map((r) => r.total))
  const weekends = median(rows.filter((r) => r.dow >= 6).map((r) => r.total))
  assert.ok(weekends < weekdays * 0.75, `weekend ${weekends} vs weekday ${weekdays}`)

  // A launch is one day plus a tail, not a plateau: the peak has to stand
  // clearly above the day that follows it or the chart reads as a step change.
  const spikeDays = rows.filter((r) => r.total > baseline * 2)
  assert.ok(spikeDays.length >= 2 && spikeDays.length <= 5, `one spike, got ${spikeDays.length}`)
  const runnerUp = [...totals].sort((a, b) => b - a)[1]
  assert.ok(peak > runnerUp * 1.5, `the peak must dominate its own tail: ${peak} vs ${runnerUp}`)

  const { rows: share } = await db.pool.query<{ bot_share: number }>(
    `SELECT (sum(bot_clicks)::numeric / (sum(clicks) + sum(bot_clicks)))::float8 AS bot_share
       FROM click_daily`
  )
  assert.ok(
    share[0].bot_share > 0.08 && share[0].bot_share < 0.16,
    `bot share should sit near 12%, got ${share[0].bot_share}`
  )

  const { rows: kinds } = await db.pool.query<{ bot_kind: string }>(
    'SELECT DISTINCT bot_kind FROM click_events WHERE is_bot ORDER BY bot_kind'
  )
  assert.deepEqual(
    kinds.map((k) => k.bot_kind),
    ['discord', 'facebook', 'slack', 'telegram', 'whatsapp']
  )

  const { rows: honest } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM click_events
      WHERE (is_bot AND bot_kind IS NULL) OR (NOT is_bot AND bot_kind IS NOT NULL)`
  )
  assert.equal(honest[0].n, 0, 'bot_kind is set exactly when is_bot is true')
})

test('geography and devices are skewed, not uniform', async () => {
  const { rows: geo } = await db.pool.query<{ country: string; n: number }>(
    `SELECT country, count(*)::int AS n FROM click_events
      WHERE NOT is_bot GROUP BY country ORDER BY n DESC`
  )
  assert.ok(geo.length >= 12, `a long tail needs many countries, got ${geo.length}`)

  const total = geo.reduce((sum, row) => sum + row.n, 0)
  const dominant = geo[0].n / total
  assert.ok(dominant > 0.3 && dominant < 0.7, `one dominant country, got ${dominant}`)
  assert.ok(geo[geo.length - 1].n / total < 0.02, 'and a genuinely thin tail')

  const { rows: devices } = await db.pool.query<{ device: string; n: number }>(
    `SELECT device, count(*)::int AS n FROM click_events
      WHERE NOT is_bot GROUP BY device ORDER BY n DESC`
  )
  assert.deepEqual(
    devices.map((d) => d.device).sort(),
    ['desktop', 'mobile', 'tablet']
  )
  assert.ok(devices[0].device === 'mobile', 'mobile leads, as it does everywhere')
  assert.ok(devices[0].n / total > 0.5)

  const { rows: pairs } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM click_events
      WHERE NOT is_bot AND (device IS NULL OR os IS NULL OR browser IS NULL)`
  )
  assert.equal(pairs[0].n, 0, 'a human click always carries a device stack')
})

test('clicksDays narrows the history window', async () => {
  const small = await migrated('panel_seed_demo_short')
  try {
    const short = await seedDemo(small.pool, { clicksDays: 14 })

    const { rows } = await small.pool.query<{ days: number; first: string; last: string }>(
      `SELECT count(DISTINCT day)::int AS days,
              to_char(min(day), 'YYYY-MM-DD') AS first,
              to_char(max(day), 'YYYY-MM-DD') AS last
         FROM click_daily`
    )
    assert.ok(rows[0].days <= 14 && rows[0].days >= 12, `got ${rows[0].days} days`)
    assert.equal(rows[0].last, new Date().toISOString().slice(0, 10), 'history ends today')
    assert.ok(short.clicks < counts.clicks, 'a shorter window means fewer clicks')
    assert.equal(short.links, counts.links, 'the account itself is unchanged')

    const { rows: stranded } = await small.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM click_events_default'
    )
    assert.equal(stranded[0].n, 0)
  } finally {
    await small.end()
  }
})
