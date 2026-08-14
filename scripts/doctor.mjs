#!/usr/bin/env node
// What an operator runs when something is wrong.
//
// Every check prints PASS or FAIL and, when it fails, one specific next step —
// a command to run or a record to create, never "check your configuration".
// The process exits non-zero if anything failed, so it composes with CI and
// with `&&` in a shell.
//
// Dependencies: node builtins and `pg`, which the product already carries. A
// diagnostic that needs an install is a diagnostic nobody runs.

import dns from 'node:dns/promises'
import tls from 'node:tls'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', 'db', 'migrations')

const DEFAULT_TIMEOUT_MS = 8_000
// The spec sets the sentinel at 60s: past that, a scheduled swap visibly fires
// at the wrong minute for whoever set it.
const DEFAULT_CLOCK_TOLERANCE_MS = 60_000
// A certificate this close to expiry has already failed to renew at least once.
const CERT_WARN_DAYS = 7
const SCHEMA_RE = /^[a-z][a-z0-9_]{0,48}$/
const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full'])

const pass = (name, detail) => ({ name, ok: true, detail })
const fail = (name, detail, next) => ({ name, ok: false, detail, next })

// ---------------------------------------------------------------- connection

function parseUrl(databaseUrl) {
  const url = new URL(databaseUrl)
  const sslmode = url.searchParams.get('sslmode')
  // The probe decides TLS explicitly, so the parameter is removed first:
  // pg lets the connection string override the config object, and a leftover
  // sslmode would quietly win over the mode being tested.
  url.searchParams.delete('sslmode')
  return {
    sslmode,
    wantsTls: TLS_MODES.has(sslmode ?? ''),
    bare: url.toString(),
    label: `${url.hostname || 'localhost'}:${url.port || 5432}${url.pathname}`,
  }
}

function connectionOptions(schema) {
  if (schema === undefined) return undefined
  if (!SCHEMA_RE.test(schema)) throw new TypeError(`invalid schema name: ${schema}`)
  return `-c search_path=${schema},public`
}

async function probeConnection(bare, ssl, { timeoutMs, options }) {
  const client = new pg.Client({
    connectionString: bare,
    ssl,
    options,
    connectionTimeoutMillis: timeoutMs,
  })
  const started = Date.now()
  try {
    await client.connect()
    await client.query('SELECT 1')
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error }
  } finally {
    await client.end().catch(() => {})
  }
}

function unreachableNextStep(error) {
  switch (error?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The host in DATABASE_URL does not resolve. On Railway the private host is `<service>.railway.internal` and only resolves from inside the project; from your laptop use the public proxy URL instead.'
    case 'ECONNREFUSED':
      return 'Nothing is listening on that host and port. Start Postgres (`docker compose up -d postgres`), or correct the port in DATABASE_URL.'
    case 'ETIMEDOUT':
      return 'The connection timed out. A firewall or security group is dropping the packets before Postgres sees them.'
    case '28P01':
      return 'The password in DATABASE_URL is wrong. Copy it again from the postgres service — do not retype it.'
    case '28000':
      return 'The server rejected this user. Check the user in DATABASE_URL against pg_hba.conf.'
    case '3D000':
      return 'That database does not exist on the server. Create it (`createdb linkyard`) or correct the name at the end of DATABASE_URL.'
    default:
      return 'Fix the connection before anything else: every other check reads from this database.'
  }
}

/**
 * The one check that has already cost this project a deploy.
 *
 * Railway's private network speaks plain TCP between services and rejects an
 * SSL handshake outright, so a service that reasons "not localhost, therefore
 * TLS" crashes at boot with an error that reads like the database is down. The
 * check therefore never reports "cannot connect" without first establishing
 * whether the *other* TLS mode would have worked — that difference is the whole
 * diagnosis.
 */
async function checkDatabase(parsed, ctx) {
  const declared = parsed.sslmode ? `sslmode=${parsed.sslmode}` : 'no sslmode in the URL'
  const primary = parsed.wantsTls ? { rejectUnauthorized: false } : false
  const fallback = parsed.wantsTls ? false : { rejectUnauthorized: false }

  const first = await probeConnection(parsed.bare, primary, ctx)
  if (first.ok) {
    const how = parsed.wantsTls ? 'TLS in force' : 'plain TCP'
    return {
      result: pass('database', `connected to ${parsed.label} in ${first.ms} ms — ${how}, ${declared}`),
      ssl: primary,
    }
  }

  const second = await probeConnection(parsed.bare, fallback, ctx)
  if (second.ok && parsed.wantsTls) {
    return {
      result: fail(
        'database',
        `${parsed.label} refuses the TLS handshake the URL asks for (${declared}), but accepts the same connection in plain TCP`,
        'Remove ?sslmode=require from DATABASE_URL. Railway\'s private network speaks plain TCP between services and rejects an SSL handshake, so a service that assumes TLS dies at boot with what looks like a database outage.'
      ),
    }
  }
  if (second.ok) {
    return {
      result: fail(
        'database',
        `${parsed.label} rejects a plain connection and accepts a TLS one, but the URL carries ${declared}`,
        'Append ?sslmode=require to DATABASE_URL. Managed providers outside Railway usually terminate TLS and refuse anything else.'
      ),
    }
  }

  return {
    result: fail(
      'database',
      `${parsed.label} is unreachable (${declared}): ${first.error.message}`,
      unreachableNextStep(first.error)
    ),
  }
}

// ---------------------------------------------------------------- migrations

async function checkMigrations(pool, migrationsDir) {
  let applied
  try {
    const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
    applied = rows.map((r) => r.version)
  } catch (err) {
    // 42P01: the ledger table itself is absent, so nothing has ever run here.
    if (err.code !== '42P01') throw err
    return fail(
      'migrations',
      'schema_migrations does not exist — this database has never been migrated',
      'Run `npm run migrate` with DATABASE_URL set, or restart the panel: it migrates at boot.'
    )
  }

  const onDisk = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort()

  const appliedSet = new Set(applied)
  const missing = onDisk.filter((v) => !appliedSet.has(v))
  const diskSet = new Set(onDisk)
  const unknown = applied.filter((v) => !diskSet.has(v))

  if (missing.length) {
    return fail(
      'migrations',
      `${missing.length} of ${onDisk.length} migrations have not been applied: ${missing.join(', ')}`,
      'Run `npm run migrate` with DATABASE_URL set. Code that expects a column the database does not have fails in ways that read like data corruption.'
    )
  }
  if (unknown.length) {
    return fail(
      'migrations',
      `the database is ahead of this checkout: ${unknown.join(', ')} applied but not present in ${migrationsDir}`,
      'Deploy the release that owns those migrations. Running older code against a newer schema is the one direction migrations cannot protect.'
    )
  }
  return pass('migrations', `all ${onDisk.length} applied, latest ${onDisk.at(-1)}`)
}

// --------------------------------------------------------------------- clock

async function checkClock(pool, { clockToleranceMs, now }) {
  const before = now()
  const { rows } = await pool.query('SELECT clock_timestamp() AS db_now')
  const after = now()

  // The midpoint of the round trip is the closest the app can get to "what my
  // clock read at the instant the server read its own".
  const drift = Math.abs(new Date(rows[0].db_now).getTime() - (before + after) / 2)
  const seconds = (drift / 1000).toFixed(1)
  const roundTrip = after - before

  if (drift > clockToleranceMs) {
    return fail(
      'clock',
      `the app and Postgres disagree by ${seconds}s (round trip ${roundTrip} ms, tolerance ${(clockToleranceMs / 1000).toFixed(1)}s)`,
      'Enable NTP on whichever host is wrong (`timedatectl set-ntp true`, then `timedatectl status`). A scheduled swap fires on the database clock, so it will land that far from the time the person picked.'
    )
  }
  return pass('clock', `app and Postgres agree within ${seconds}s (round trip ${roundTrip} ms)`)
}

// ---------------------------------------------------------------- subdomains

const realProbes = {
  async resolveHost(host, { timeoutMs }) {
    const records = []
    const lookups = [
      ['CNAME', dns.resolveCname(host)],
      ['A', dns.resolve4(host)],
      ['AAAA', dns.resolve6(host)],
    ]
    let lastError = null
    for (const [type, promise] of lookups) {
      try {
        for (const value of await promise) records.push(`${type} ${value}`)
      } catch (err) {
        lastError = err
      }
    }

    // Railway's newer custom-domain flow needs a TXT alongside the CNAME, and a
    // missing one leaves the domain in VALIDATING_OWNERSHIP forever with no
    // error anywhere. Its absence is reported, never treated as fatal: a VPS
    // install has no such record and is perfectly healthy without it.
    let railwayVerifyTxt = false
    try {
      const txt = await dns.resolveTxt(`_railway-verify.${host}`)
      railwayVerifyTxt = txt.length > 0
    } catch {
      railwayVerifyTxt = false
    }

    if (!records.length) return { ok: false, error: lastError?.code ?? 'no records', railwayVerifyTxt }
    return { ok: true, records, railwayVerifyTxt, timeoutMs }
  },

  async inspectCertificate(host, { timeoutMs }) {
    return new Promise((resolve) => {
      // rejectUnauthorized is false on purpose: a bad chain has to arrive as a
      // finding in the report, not as a thrown error that hides which host.
      const socket = tls.connect(
        { host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
        () => {
          const cert = socket.getPeerCertificate()
          const validTo = cert?.valid_to ? new Date(cert.valid_to) : null
          socket.destroy()
          resolve({
            ok: true,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
            issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? 'unknown issuer',
            daysRemaining: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null,
          })
        }
      )
      socket.on('timeout', () => {
        socket.destroy()
        resolve({ ok: false, error: 'the TLS handshake timed out' })
      })
      socket.on('error', (err) => resolve({ ok: false, error: err.message }))
    })
  },

  async fetchHealth(host, { healthPath, timeoutMs }) {
    try {
      const res = await fetch(`https://${host}${healthPath}`, {
        // A redirect is an answer worth seeing, not something to follow: the
        // edge answering 302 on its own health path means the path is being
        // resolved as a link.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { ok: res.status === 200, status: res.status }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },
}

function dnsNextStep(row) {
  if (row.record_type && row.record_value) {
    return `Create the DNS record the panel already recorded for this host: ${row.record_type} ${row.host} → ${row.record_value}. Until it resolves the link is dead for everyone who clicks it.`
  }
  return `No DNS record is recorded for ${row.host} either. Re-run provisioning for this subdomain from the panel, or point it at the edge by hand.`
}

async function checkSubdomain(row, ctx) {
  const results = []
  const { probes } = ctx

  const resolved = await probes.resolveHost(row.host, ctx)
  if (resolved.ok) {
    const txt = resolved.railwayVerifyTxt ? ', _railway-verify TXT present' : ''
    results.push(pass(`dns ${row.host}`, `${resolved.records.join(', ')}${txt}`))
  } else {
    results.push(fail(`dns ${row.host}`, `does not resolve (${resolved.error})`, dnsNextStep(row)))
  }

  const cert = await probes.inspectCertificate(row.host, ctx)
  if (!cert.ok) {
    results.push(
      fail(
        `certificate ${row.host}`,
        `no TLS handshake on port 443: ${cert.error}`,
        'On a VPS, confirm Caddy is running and holds a wildcard for this apex (`docker compose logs caddy`). On Railway, confirm the custom domain exists and both its CNAME and its _railway-verify TXT are in DNS.'
      )
    )
  } else if (!cert.authorized || (cert.daysRemaining !== null && cert.daysRemaining < 0)) {
    results.push(
      fail(
        `certificate ${row.host}`,
        `served but not valid for this host: ${cert.authorizationError ?? 'expired'} (${cert.daysRemaining} days remaining)`,
        'Reissue the certificate. On a VPS the wildcard comes from the Cloudflare DNS-01 challenge — check CLOUDFLARE_API_TOKEN is still valid and scoped to this zone.'
      )
    )
  } else if (cert.daysRemaining !== null && cert.daysRemaining < CERT_WARN_DAYS) {
    results.push(
      fail(
        `certificate ${row.host}`,
        `expires in ${cert.daysRemaining} days (${cert.issuer})`,
        'Renewal has already missed at least one window. Check the Caddy logs, or the Railway domain status, before it lapses.'
      )
    )
  } else {
    results.push(
      pass(`certificate ${row.host}`, `valid for ${cert.daysRemaining} more days (${cert.issuer})`)
    )
  }

  const health = await probes.fetchHealth(row.host, ctx)
  if (health.ok) {
    results.push(pass(`health ${row.host}`, `${ctx.healthPath} answered 200`))
  } else {
    results.push(
      fail(
        `health ${row.host}`,
        health.error
          ? `${ctx.healthPath} did not answer: ${health.error}`
          : `${ctx.healthPath} answered ${health.status}`,
        'The name and the certificate are fine, so the edge itself is the problem. Read its logs (`docker compose logs edge`, or the Railway deploy logs) — every link on this host is down while this fails.'
      )
    )
  }

  return results
}

async function checkSubdomains(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT s.host, s.record_type, s.record_value
       FROM subdomains s
       JOIN domains d ON d.id = s.domain_id
      WHERE s.active AND d.active
      ORDER BY lower(s.host)`
  )

  if (!rows.length) {
    return [pass('subdomains', 'none configured yet — nothing to resolve')]
  }

  const results = [pass('subdomains', `${rows.length} active`)]
  for (const row of rows) results.push(...(await checkSubdomain(row, ctx)))
  return results
}

// ------------------------------------------------------- partitions and data

const PART_RE = /^click_events_(\d{4})_(\d{2})$/

function partitionNameFor(date) {
  // UTC, matching db/retention.mjs. Two modules disagreeing about which month
  // it is near a boundary would create a partition nobody looks for.
  return `click_events_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthStart(from, offset) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1))
}

async function listPartitions(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname LIKE 'click_events_%'
      ORDER BY c.relname`
  )
  return rows.map((r) => r.relname)
}

async function checkPartitions(pool, { now }) {
  const names = new Set(await listPartitions(pool))
  const today = new Date(now())
  const wanted = [monthStart(today, 0), monthStart(today, 1)]
  const missing = wanted.filter((d) => !names.has(partitionNameFor(d)))

  const { rows: caught } = await pool.query('SELECT count(*)::int AS n FROM click_events_default')
  const catchAll = caught[0].n
    ? `; the catch-all holds ${caught[0].n} events that landed with no partition of their own`
    : ''

  if (missing.length) {
    const sql = missing
      .map((d) => `SELECT ensure_click_partition('${d.toISOString().slice(0, 10)}'::date);`)
      .join(' ')
    return fail(
      'partitions',
      `missing: ${missing.map(partitionNameFor).join(', ')}${catchAll}`,
      `Create them now: ${sql} Without them every click lands in click_events_default, which the retention purge cannot drop.`
    )
  }
  return pass(
    'partitions',
    `${wanted.map(partitionNameFor).join(' and ')} exist${catchAll || ' and the catch-all is empty'}`
  )
}

async function checkRetention(pool, { now }) {
  const { rows: setting } = await pool.query(
    `SELECT value FROM settings WHERE key = 'click_retention_days'`
  )
  if (!setting.length) {
    return fail(
      'retention',
      'click_retention_days is not in the settings table',
      `Restore it: INSERT INTO settings (key, value) VALUES ('click_retention_days', '180'::jsonb);`
    )
  }
  const configured = Number(setting[0].value)

  const months = (await listPartitions(pool))
    .map((name) => ({ name, match: PART_RE.exec(name) }))
    .filter((p) => p.match)
    .map(({ name, match }) => ({
      name,
      start: new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)),
      end: new Date(Date.UTC(Number(match[1]), Number(match[2]), 1)),
    }))
    .sort((a, b) => a.start - b.start)

  if (!months.length) {
    return pass('retention', `collecting — no monthly partition holds events yet (window ${configured} days)`)
  }

  const cutoff = new Date(now() - configured * 86_400_000)
  // A partition expires only once its LAST day is behind the cutoff, exactly as
  // db/retention.mjs decides — a stricter rule here would report a failure the
  // purge is right not to act on.
  const expired = months.filter((m) => m.end <= cutoff)
  const stored = Math.floor((now() - months[0].start.getTime()) / 86_400_000)

  if (expired.length) {
    return fail(
      'retention',
      `storing ${stored} days against a configured window of ${configured}: ${expired.map((m) => m.name).join(', ')} should already be gone`,
      'The purge has not run. Run dropExpiredPartitions from db/retention.mjs, or drop those tables directly — they are whole partitions, so the disk comes back immediately and click_daily keeps the history.'
    )
  }
  return pass(
    'retention',
    `storing ${stored} days across ${months.length} partition(s) from ${months[0].name.slice(-7).replace('_', '-')}, window ${configured} days`
  )
}

// ----------------------------------------------------------------- the runner

export async function runChecks({
  databaseUrl = process.env.DATABASE_URL,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  schema,
  healthPath = process.env.LINKYARD_HEALTH_PATH || '/healthz',
  clockToleranceMs = DEFAULT_CLOCK_TOLERANCE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  probes = realProbes,
} = {}) {
  if (!databaseUrl) {
    return {
      ok: false,
      results: [
        fail(
          'database',
          'DATABASE_URL is not set',
          'Export DATABASE_URL, or run the doctor inside the service that has it (`docker compose exec panel node scripts/doctor.mjs`, or `railway run node scripts/doctor.mjs`).'
        ),
      ],
    }
  }

  let parsed
  try {
    parsed = parseUrl(databaseUrl)
  } catch {
    return {
      ok: false,
      results: [
        fail(
          'database',
          'DATABASE_URL is not a valid connection URL',
          'Expected a postgres:// URL carrying the user and password, then the host and port, then the database name. A password containing @, / or & has to be percent-encoded.'
        ),
      ],
    }
  }

  const options = connectionOptions(schema)
  const ctx = { timeoutMs, options, healthPath, clockToleranceMs, now, probes }

  const database = await checkDatabase(parsed, ctx)
  // Everything below reads from the database, so a failure here would only
  // produce a screen of consequences of the one problem already named.
  if (!database.result.ok) {
    return {
      ok: false,
      results: [database.result],
      stopped: 'the database check: every other check reads from it',
    }
  }

  const pool = new pg.Pool({
    connectionString: parsed.bare,
    ssl: database.ssl,
    options,
    max: 2,
    connectionTimeoutMillis: timeoutMs,
  })

  const results = [database.result]
  let stopped
  try {
    const migrations = await guard('migrations', () => checkMigrations(pool, migrationsDir))
    results.push(migrations)
    results.push(await guard('clock', () => checkClock(pool, ctx)))

    // The remaining checks read product tables. Against a schema that is behind
    // — or empty — they can only restate the missing migration, one relation at
    // a time.
    if (migrations.ok) {
      results.push(...(await guardMany('subdomains', () => checkSubdomains(pool, ctx))))
      results.push(await guard('partitions', () => checkPartitions(pool, ctx)))
      results.push(await guard('retention', () => checkRetention(pool, ctx)))
    } else {
      stopped = 'the migrations check: the tables the remaining checks read may not exist yet'
    }
  } finally {
    await pool.end().catch(() => {})
  }

  return { ok: results.every((r) => r.ok), results, stopped }
}

// A diagnostic that throws is useless precisely when it is needed: the shape of
// a broken installation is an unexpected error, so an unexpected error has to
// arrive as a finding like any other.
function unexpected(name, err) {
  return fail(
    name,
    `the check itself failed: ${err.message}`,
    'This is not a state the product creates on its own. Compare the schema against db/migrations, then re-run.'
  )
}

async function guard(name, run) {
  try {
    return await run()
  } catch (err) {
    return unexpected(name, err)
  }
}

async function guardMany(name, run) {
  try {
    return await run()
  } catch (err) {
    return [unexpected(name, err)]
  }
}

export function formatReport({ results, ok, stopped }) {
  const width = Math.max(...results.map((r) => r.name.length))
  const lines = []
  for (const r of results) {
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
    if (!r.ok && r.next) lines.push(`      ${' '.repeat(width)}  → ${r.next}`)
  }
  lines.push('')
  if (stopped) {
    lines.push(`Stopped after ${stopped}.`)
  } else {
    const failed = results.filter((r) => !r.ok).length
    lines.push(ok ? `${results.length} checks, all passing.` : `${failed} of ${results.length} checks failing.`)
  }
  return lines.join('\n')
}

export async function main() {
  const report = await runChecks()
  console.log(formatReport(report))
  return report.ok ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main())
}
