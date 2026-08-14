import { query } from './db.server.ts'

// The fold: click_events in, click_daily out.
//
// The edge writes one row per fetch and the panel reads none of them — every
// figure that spans days comes from click_daily, because scanning millions of
// raw rows to draw a chart is the cost the partitioned schema exists to avoid.
// Without this module the two halves never meet: a real click is recorded and
// no report ever shows it.
//
// Three rules govern everything below.
//
// Recompute, never increment. A fold is a full recomputation of the day from
// the events that exist at that moment, written with ON CONFLICT DO UPDATE. It
// is therefore safe to run twice, safe to run from two processes, and safe to
// re-run after a late event arrives. An increment would be none of those.
//
// Bots are counted and excluded. WhatsApp, Meta, Telegram, Slack and Discord
// all fetch a link to build a preview. They land in bot_clicks and stay out of
// clicks, uniques and every breakdown bucket — the same rule reports.server.ts
// applies, because a number that differs between two screens is worse than a
// number nobody shows.
//
// Days are UTC. The edge stamps occurred_at in absolute time and the reports
// layer reads click_daily.day as a UTC date; bucketing here in the database
// session's time zone would slide a late evening in America/Sao_Paulo into the
// neighbouring day and make the chart disagree with its own totals.

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// Two full days plus the current one. A fold that runs hourly only needs the
// day it is in, but a missed run, a deploy, or an event that arrived late must
// not leave a day permanently short, and re-folding a settled day costs one
// index scan over a window that is already in cache.
const RECENT_HOURS = 48

function dayString(date: Date): string {
  const time = date.getTime()
  if (Number.isNaN(time)) throw new TypeError('rollup day is not a valid date')
  return new Date(time).toISOString().slice(0, 10)
}

function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

type FoldedRow = { link_id: string; day: string; clicks: number }

// One statement for the whole window, grouped by (link_id, day).
//
// The JOIN on links is load-bearing twice over. click_events carries no foreign
// key — one would cost an index write on the hottest insert path in the product
// — so a hard-deleted link leaves orphan events behind, and click_daily *does*
// have a foreign key: inserting a row for a link that no longer exists would
// abort the fold for every other link in the window. The join drops the orphans
// instead.
//
// It deliberately does not filter deleted_at. A link in the trash keeps its
// history, the report layer decides whether to show it, and dropping it here
// would silently lose the numbers the moment the raw events are purged.
const FOLD = `
WITH windowed AS (
  SELECT e.link_id,
         (e.occurred_at AT TIME ZONE 'UTC')::date        AS day,
         e.is_bot,
         e.ip_hash,
         COALESCE(NULLIF(e.country, ''), 'unknown')      AS country,
         COALESCE(NULLIF(e.device, ''), 'unknown')       AS device,
         -- No referrer header is not an unknown referrer: the visitor typed the
         -- link or tapped it somewhere that sends none. 'direct' is the word the
         -- report layer already labels, so the fold speaks its vocabulary.
         COALESCE(NULLIF(e.referrer_host, ''), 'direct') AS referrer
    FROM click_events e
    JOIN links l ON l.id = e.link_id
   WHERE e.occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
     AND e.occurred_at <  (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
),
totals AS (
  SELECT link_id, day,
         count(*) FILTER (WHERE NOT is_bot)::int                   AS clicks,
         -- A fetch with no hash belongs to no visitor. Folding them into one
         -- synthetic bucket would invent a returning visitor that never
         -- existed, so they raise clicks and leave uniques alone.
         count(DISTINCT ip_hash) FILTER (WHERE NOT is_bot)::int    AS uniques,
         count(*) FILTER (WHERE is_bot)::int                       AS bot_clicks
    FROM windowed
   GROUP BY link_id, day
),
countries AS (
  SELECT link_id, day, jsonb_object_agg(key, n) AS bucket
    FROM (SELECT link_id, day, country AS key, count(*)::int AS n
            FROM windowed WHERE NOT is_bot GROUP BY 1, 2, 3) x
   GROUP BY link_id, day
),
devices AS (
  SELECT link_id, day, jsonb_object_agg(key, n) AS bucket
    FROM (SELECT link_id, day, device AS key, count(*)::int AS n
            FROM windowed WHERE NOT is_bot GROUP BY 1, 2, 3) x
   GROUP BY link_id, day
),
referrers AS (
  SELECT link_id, day, jsonb_object_agg(key, n) AS bucket
    FROM (SELECT link_id, day, referrer AS key, count(*)::int AS n
            FROM windowed WHERE NOT is_bot GROUP BY 1, 2, 3) x
   GROUP BY link_id, day
)
INSERT INTO click_daily
  (link_id, day, clicks, uniques, bot_clicks, by_country, by_device, by_referrer, updated_at)
SELECT t.link_id, t.day, t.clicks, t.uniques, t.bot_clicks,
       COALESCE(c.bucket, '{}'::jsonb),
       COALESCE(d.bucket, '{}'::jsonb),
       COALESCE(r.bucket, '{}'::jsonb),
       now()
  FROM totals t
  LEFT JOIN countries c ON c.link_id = t.link_id AND c.day = t.day
  LEFT JOIN devices   d ON d.link_id = t.link_id AND d.day = t.day
  LEFT JOIN referrers r ON r.link_id = t.link_id AND r.day = t.day
    ON CONFLICT (link_id, day) DO UPDATE SET
       clicks      = EXCLUDED.clicks,
       uniques     = EXCLUDED.uniques,
       bot_clicks  = EXCLUDED.bot_clicks,
       by_country  = EXCLUDED.by_country,
       by_device   = EXCLUDED.by_device,
       by_referrer = EXCLUDED.by_referrer,
       updated_at  = now()
 RETURNING link_id::text AS link_id, day::text AS day, clicks`

// A day with no events produces no row here, and that is the whole reason the
// statement writes nothing rather than zeroing what it finds: retention drops
// click_events partitions long before the rollups expire, and a fold re-run
// over a purged window must leave last quarter's chart exactly where it is.
async function fold(from: string, to: string): Promise<FoldedRow[]> {
  return query<FoldedRow>(FOLD, [from, to])
}

function clicksIn(rows: FoldedRow[]): number {
  return rows.reduce((total, row) => total + row.clicks, 0)
}

/**
 * Fold one UTC day.
 *
 * Returns the number of (link, day) rows written and the human clicks they
 * carry — bots are in the rollup but not in this figure, so a job log reads the
 * same number the panel will.
 */
export async function rollupDay(day: Date): Promise<{ links: number; clicks: number }> {
  const target = dayString(day)
  const rows = await fold(target, target)
  return { links: rows.length, clicks: clicksIn(rows) }
}

/**
 * Fold every UTC day from `from` to `to`, inclusive.
 *
 * `days` is the span the fold covered, whether or not each day had traffic: it
 * describes the work, not the findings.
 */
export async function rollupRange(from: Date, to: Date): Promise<{ days: number; clicks: number }> {
  const start = dayString(from)
  const end = dayString(to)
  if (start > end) {
    throw new RangeError(`rollup range ends before it starts: ${start} to ${end}`)
  }
  const rows = await fold(start, end)
  return { days: daySpan(start, end), clicks: clicksIn(rows) }
}

/**
 * Fold the days touched by the last `hours` hours.
 *
 * The window is widened to whole UTC days, and it has to be: the fold
 * recomputes a day from the events inside its window, so a literal "last hour"
 * would recompute today from one hour of traffic and overwrite the morning with
 * a smaller number. Widening costs a scan; not widening loses clicks.
 */
export async function rollupRecent(hours = RECENT_HOURS): Promise<{ days: number; clicks: number }> {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new TypeError('hours must be a positive number')
  }
  const now = Date.now()
  return rollupRange(new Date(now - hours * HOUR_MS), new Date(now))
}
