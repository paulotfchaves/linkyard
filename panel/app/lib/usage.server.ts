import { statfs } from 'node:fs/promises'
import { query, queryOne } from './db.server.ts'

// The infrastructure usage monitor.
//
// Three services on Railway cost roughly US$ 5.50–7.00 a month and the US$ 5
// Hobby allowance does not cover them. The product says so before the deploy;
// this module is what keeps saying it afterwards, while there is still time to
// act. A monitor that reports the overspend once the invoice arrives is a
// receipt, not a monitor, so every number here is a projection to the end of
// the current cycle rather than a running total.
//
// Two properties matter more than accuracy:
//
// It never fails. Sampling runs on a timer next to the rollup, and a monitor
// that throws because a token expired takes the job — and the fold with it —
// down for something nobody is paying attention to. Every remote failure
// degrades to a local sample instead.
//
// It never guesses upward. The projection is withheld in the first hour of a
// cycle, where a few cents of spend extrapolate to hundreds of dollars, and
// says so. A badge that cries wolf on day one is a badge people learn to skip.

export type UsageSource = 'railway' | 'local'

export type UsageSample = {
  id: number
  sampledAt: Date
  source: UsageSource
  cpuVcpu: number | null
  memoryGb: number | null
  egressGb: number | null
  diskGb: number | null
  estimatedCost: number | null
  periodStart: Date | null
  periodEnd: Date | null
}

/** The part of a sample a projection needs. A full UsageSample satisfies it. */
export type CostSample = Pick<
  UsageSample,
  'sampledAt' | 'estimatedCost' | 'periodStart' | 'periodEnd'
>

export type UsageLevel = 'ok' | 'warning' | 'over' | 'unknown'

export type UsageStatus = {
  level: UsageLevel
  projected: number
  planCeiling: number
  daysLeft: number
  advice: string[]

  // Where the numbers came from, and the numbers themselves.
  //
  // Without these the screen could only ever talk about money, which is a
  // Railway concept. A Compose install on somebody's own VPS has no bill to
  // read, so it was shown "$0.00 of $5.00", told it was comfortably inside a
  // plan it is not on, and advised to set two Railway variables that mean
  // nothing there — while the CPU, memory and disk this module had already
  // measured were collected every hour and displayed nowhere.
  source: UsageSource | null
  sampledAt: string | null
  cpuVcpu: number | null
  memoryGb: number | null
  diskGb: number | null
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// The Railway Hobby allowance. An operator on another plan says so through the
// environment; nothing here reads a price list, because a hard-coded one goes
// stale silently and a stale ceiling is worse than an honest default.
const DEFAULT_CEILING_USD = 5

// Warn while a fifth of the allowance is still unspent. Warning at 100% is the
// same as not warning: the money is already committed for the cycle.
const WARNING_FRACTION = 0.8

// Below an hour of elapsed cycle the denominator is small enough that the
// provider's own rounding dominates the rate. The projection is withheld rather
// than inflated.
const MIN_ELAPSED_MS = HOUR_MS

// Enough history to cover a cycle sampled hourly without reading a table that
// grows forever; only the newest priced sample drives the projection.
const SAMPLE_WINDOW = 96

const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2'
const RAILWAY_TIMEOUT_MS = 8_000

// No measurement enum literals appear in the query text on purpose: a value
// this schema has renamed would fail the whole request, while an unfamiliar
// measurement in the *response* is simply ignored below.
const USAGE_QUERY = `query linkyardUsage($projectId: String!) {
  estimatedUsage(projectId: $projectId) {
    measurement
    estimatedValue
  }
}`

type Measured = {
  cpuVcpu: number | null
  memoryGb: number | null
  egressGb: number | null
  diskGb: number | null
  estimatedCost: number | null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function usd(value: number): string {
  return value.toFixed(2)
}

function calendarMonth(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  }
}

function planCeiling(): number {
  const raw = Number(process.env.PLAN_CEILING_USD)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CEILING_USD
}

function railwayCredentials(): { token: string; projectId: string } | null {
  const token = process.env.RAILWAY_API_TOKEN?.trim()
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim()
  return token && projectId ? { token, projectId } : null
}

// Off is an explicit choice, not the default: a VPS operator paying a flat
// monthly bill gets nothing from this table except growth.
function monitorEnabled(): boolean {
  const raw = (process.env.USAGE_MONITOR ?? '').trim().toLowerCase()
  return raw !== 'off' && raw !== '0' && raw !== 'false'
}

/** The dollars measurement, whatever this schema version decided to call it. */
function dollarsIn(values: Map<string, number>): number | null {
  for (const [key, value] of values) {
    if (key.endsWith('_USD')) return value
  }
  return null
}

async function readRailway(token: string, projectId: string): Promise<Measured | null> {
  let payload: unknown
  try {
    const response = await fetch(RAILWAY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: USAGE_QUERY, variables: { projectId } }),
      // A hung API must not hold the sampler — and through it the job that runs
      // the rollup — for the length of a socket timeout.
      signal: AbortSignal.timeout(RAILWAY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    payload = await response.json()
  } catch {
    // A DNS failure, a timeout, a body that is not JSON: from here they are the
    // same event — no reading this time — and the caller's answer to all three
    // is the local sample.
    return null
  }

  const body = payload as {
    data?: { estimatedUsage?: unknown }
    errors?: unknown[]
  }
  // GraphQL reports an expired token as HTTP 200 with an errors array. Reading
  // `data` without checking would record a sample of nothing.
  if (Array.isArray(body?.errors) && body.errors.length > 0) return null

  const entries = body?.data?.estimatedUsage
  if (!Array.isArray(entries)) return null

  const values = new Map<string, number>()
  for (const entry of entries) {
    const { measurement, estimatedValue } = (entry ?? {}) as {
      measurement?: unknown
      estimatedValue?: unknown
    }
    if (typeof measurement === 'string' && typeof estimatedValue === 'number') {
      if (Number.isFinite(estimatedValue)) values.set(measurement.toUpperCase(), estimatedValue)
    }
  }

  const measured: Measured = {
    cpuVcpu: values.get('CPU_USAGE') ?? null,
    memoryGb: values.get('MEMORY_USAGE_GB') ?? null,
    egressGb: values.get('NETWORK_TX_GB') ?? null,
    // Volume usage first: it is the figure an operator can act on. The
    // ephemeral disk is a fallback, not a substitute.
    diskGb: values.get('DISK_USAGE_GB') ?? values.get('EPHEMERAL_DISK_USAGE_GB') ?? null,
    estimatedCost:
      values.get('ESTIMATED_USAGE_USD') ?? values.get('ESTIMATED_COST_USD') ?? dollarsIn(values),
  }

  // Nothing recognisable came back. Recording an all-null row as a Railway
  // sample would tell the panel the API is answering when it is not.
  return Object.values(measured).some((value) => value !== null) ? measured : null
}

async function localSample(): Promise<Measured> {
  // Average vCPU since this process started, not an instantaneous reading: an
  // instantaneous one needs two samples a moment apart, and sleeping inside a
  // scheduled job to measure the job is not worth the precision.
  const uptime = process.uptime()
  const cpu = process.cpuUsage()
  const cpuVcpu = uptime > 0 ? (cpu.user + cpu.system) / 1e6 / uptime : null

  // The process's own resident set. os.totalmem() reports the host on Railway,
  // not the container's limit, so it would describe somebody else's machine.
  const memoryGb = process.memoryUsage.rss() / 1e9

  let diskGb: number | null = null
  try {
    const fs = await statfs(process.env.USAGE_DISK_PATH ?? process.cwd())
    diskGb = ((fs.blocks - fs.bfree) * fs.bsize) / 1e9
  } catch {
    // An unreadable mount costs the disk figure, never the whole sample.
    diskGb = null
  }

  // Egress is invisible from inside the process, and a flat-rate host has no
  // bill to read. Null says "not measured", which zero would not.
  return { cpuVcpu, memoryGb, egressGb: null, diskGb, estimatedCost: null }
}

type SampleRow = {
  id: string
  sampled_at: Date
  source: UsageSource
  cpu_vcpu: string | null
  memory_gb: string | null
  egress_gb: string | null
  disk_gb: string | null
  estimated_cost: string | null
  period_start: Date | null
  period_end: Date | null
}

// numeric arrives as a string from the driver, because a numeric can hold more
// precision than a double. These columns cannot, so the conversion is safe.
function num(value: string | null): number | null {
  return value === null ? null : Number(value)
}

function toSample(row: SampleRow): UsageSample {
  return {
    id: Number(row.id),
    sampledAt: row.sampled_at,
    source: row.source,
    cpuVcpu: num(row.cpu_vcpu),
    memoryGb: num(row.memory_gb),
    egressGb: num(row.egress_gb),
    diskGb: num(row.disk_gb),
    estimatedCost: num(row.estimated_cost),
    periodStart: row.period_start,
    periodEnd: row.period_end,
  }
}

const SAMPLE_COLUMNS = `id, sampled_at, source, cpu_vcpu, memory_gb, egress_gb, disk_gb,
                        estimated_cost, period_start, period_end`

/**
 * Take one sample and record it.
 *
 * Returns null only when the monitor is switched off. Everything else — no
 * token, a dead API, a schema that no longer answers the way this query expects
 * — produces a local sample, because the alternative is a gap in the series
 * exactly when something is going wrong.
 */
export async function sampleUsage(): Promise<UsageSample | null> {
  if (!monitorEnabled()) return null

  const credentials = railwayCredentials()
  const remote = credentials
    ? await readRailway(credentials.token, credentials.projectId)
    : null

  const measured = remote ?? (await localSample())
  const source: UsageSource = remote ? 'railway' : 'local'

  // Railway bills on a calendar month. The cycle is recorded next to the cost
  // rather than derived at read time, so a projection made later still knows
  // which window the money was spent in — and a local sample records none,
  // because a figure with no bill behind it has no cycle to close.
  const period = source === 'railway' ? calendarMonth(new Date()) : { start: null, end: null }

  const row = await queryOne<SampleRow>(
    `INSERT INTO usage_samples
       (source, cpu_vcpu, memory_gb, egress_gb, disk_gb, estimated_cost, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SAMPLE_COLUMNS}`,
    [
      source,
      measured.cpuVcpu,
      measured.memoryGb,
      measured.egressGb,
      measured.diskGb,
      measured.estimatedCost,
      period.start,
      period.end,
    ]
  )
  if (!row) throw new Error('usage sample was not recorded')
  return toSample(row)
}

async function recentSamples(limit = SAMPLE_WINDOW): Promise<UsageSample[]> {
  const rows = await query<SampleRow>(
    `SELECT ${SAMPLE_COLUMNS} FROM usage_samples ORDER BY sampled_at DESC LIMIT $1`,
    [limit]
  )
  return rows.map(toSample).reverse()
}

// The cycle being projected: the one the provider reported, while it is still
// open, and otherwise the calendar month `now` falls in. A closed cycle is
// never projected — last month's invoice says nothing about this month's.
function resolvePeriod(priced: CostSample[], now: Date): { start: Date; end: Date } {
  const newest = priced[priced.length - 1]
  if (
    newest?.periodStart &&
    newest.periodEnd &&
    newest.periodStart.getTime() <= now.getTime() &&
    now.getTime() < newest.periodEnd.getTime()
  ) {
    return { start: newest.periodStart, end: newest.periodEnd }
  }
  return calendarMonth(now)
}

/**
 * What this cycle closes at, and the daily rate behind it.
 *
 * The provider's estimated cost is cumulative for the cycle, so the rate is the
 * newest reading divided by the time since the cycle opened — not the gap
 * between two samples, which would be noise, and not the time since sampling
 * began, which would overstate the rate on an installation that started
 * sampling mid-cycle.
 *
 * `perDay` of 0 alongside a non-zero `projected` means the cycle is too young
 * to extrapolate: the figure is money already spent, not a forecast.
 */
export function projectCost(
  samples: CostSample[],
  now: Date
): { projected: number; perDay: number } {
  const priced = samples
    .filter((s) => typeof s.estimatedCost === 'number' && Number.isFinite(s.estimatedCost))
    .sort((a, z) => a.sampledAt.getTime() - z.sampledAt.getTime())

  const period = resolvePeriod(priced, now)
  const current = priced
    .filter(
      (s) =>
        s.sampledAt.getTime() >= period.start.getTime() &&
        s.sampledAt.getTime() < period.end.getTime()
    )
    .at(-1)
  if (!current) return { projected: 0, perDay: 0 }

  const spent = current.estimatedCost as number
  const elapsed = now.getTime() - period.start.getTime()
  if (elapsed < MIN_ELAPSED_MS) return { projected: round2(spent), perDay: 0 }

  const perDay = spent / (elapsed / DAY_MS)
  const cycleDays = (period.end.getTime() - period.start.getTime()) / DAY_MS
  return { projected: round2(perDay * cycleDays), perDay: round2(perDay) }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

async function clickEventsBytes(): Promise<number> {
  // to_regclass returns null instead of raising when the table is absent, which
  // it is on an installation whose migrations have not run yet.
  const row = await queryOne<{ bytes: string }>(
    `SELECT COALESCE(pg_total_relation_size(to_regclass('click_events')), 0)::bigint AS bytes`
  )
  return row ? Number(row.bytes) : 0
}

/**
 * The traffic light, and what to do about it.
 *
 * Every line of advice names a lever that exists in this repository or a screen
 * that exists in the Railway dashboard. "Review your usage" is not advice; it
 * is the problem restated.
 */
export async function usageStatus(): Promise<UsageStatus> {
  const now = new Date()
  const ceiling = planCeiling()
  const samples = await recentSamples()
  const { projected, perDay } = projectCost(samples, now)
  const period = resolvePeriod(
    samples.filter((s) => s.estimatedCost !== null),
    now
  )

  const daysLeft = Math.max(0, Math.ceil((period.end.getTime() - now.getTime()) / DAY_MS))
  // A level is a judgement about a bill, so it needs one. Without a priced
  // sample the honest answer is that there is nothing to judge — 'ok' would
  // read as "comfortably inside the plan", which is a reassurance nobody
  // measured.
  const priceable = samples.some((s) => s.estimatedCost !== null)
  const level: UsageLevel = !priceable
    ? 'unknown'
    : projected > ceiling
      ? 'over'
      : projected > ceiling * WARNING_FRACTION
        ? 'warning'
        : 'ok'

  const advice: string[] = []
  const latest = samples.at(-1)
  const priced = priceable
  const configured = railwayCredentials() !== null

  if (!latest) {
    advice.push(
      'No usage sample recorded yet — call sampleUsage() on a schedule (hourly is enough) so this projection has something to read.'
    )
  } else if (latest.source === 'local' && configured) {
    advice.push(
      'The last sample fell back to a local estimate: the Railway API did not answer. Check RAILWAY_API_TOKEN and RAILWAY_PROJECT_ID — until it answers, the cost projection is blind.'
    )
  } else if (!priced && !configured) {
    // Only worth saying on Railway. A Compose install on somebody's own server
    // has no bill to read, and telling its operator to set two Railway
    // variables is advice about a product they did not install.
    if (process.env.INFRA_PROVIDER === 'railway') {
      advice.push(
        'No cost figure yet: set RAILWAY_API_TOKEN and RAILWAY_PROJECT_ID to read the real bill.'
      )
    }
  }

  if (priced && perDay === 0) {
    advice.push(
      'Less than an hour into the billing cycle: the figure above is the money already spent, not a forecast. It becomes a projection at the next sample.'
    )
  }

  if (level !== 'ok') {
    const overshoot = projected - ceiling
    advice.push(
      `At US$ ${usd(perDay)}/day this cycle closes at US$ ${usd(projected)}, against an allowance of US$ ${usd(ceiling)}.` +
        (overshoot > 0 ? ` That is US$ ${usd(overshoot)} over.` : '')
    )

    const bytes = await clickEventsBytes()
    const size = bytes > 0 ? ` (click_events is holding ${formatBytes(bytes)})` : ''
    advice.push(
      `Cut click retention: run dropExpiredPartitions(pool, 90) from db/retention.mjs${size}. click_daily survives the purge, so every report keeps working.`
    )
    advice.push(
      'Sleep the panel: Railway → panel → Settings → Deploy → Serverless. The edge stays awake, so links keep resolving while nobody is on the dashboard.'
    )
    advice.push(
      'Run one replica of each service: Railway → service → Settings → Deploy → Replicas = 1.'
    )
    if (level === 'over') {
      advice.push(
        'Or raise the ceiling: Railway Pro costs US$ 20/month — upgrade, then set PLAN_CEILING_USD=20 so this monitor tracks the plan you are actually on.'
      )
    }
  }

  return {
    level,
    projected,
    planCeiling: ceiling,
    daysLeft,
    advice,
    source: latest?.source ?? null,
    sampledAt: latest ? new Date(latest.sampledAt).toISOString() : null,
    cpuVcpu: latest?.cpuVcpu ?? null,
    memoryGb: latest?.memoryGb ?? null,
    diskGb: latest?.diskGb ?? null,
  }
}
