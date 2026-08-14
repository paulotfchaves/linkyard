// Proves scripts/doctor.mjs actually fails. A diagnostic that always says PASS
// is worse than no diagnostic: it sends the operator looking somewhere else.
//
// Run: node --test scripts/test-doctor.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { migrate, MIGRATIONS_DIR } from '../db/migrate.mjs'
import { freshDatabase, TEST_URL } from '../db/test-support/helpers.mjs'
import { runChecks } from './doctor.mjs'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DOCTOR = join(HERE, 'doctor.mjs')

// Probes that never touch the network. The DNS, certificate and health checks
// reach the public internet by design, so every test that is not about them
// pins them to a known answer instead of depending on someone's DNS.
const HAPPY_PROBES = {
  async resolveHost() {
    return { ok: true, records: ['CNAME edge.example.net'], railwayVerifyTxt: true }
  },
  async inspectCertificate() {
    return { ok: true, authorized: true, daysRemaining: 60, issuer: "Let's Encrypt" }
  },
  async fetchHealth() {
    return { ok: true, status: 200 }
  },
}

async function ready(schemaName) {
  const db = await freshDatabase(schemaName)
  await migrate(db.pool, MIGRATIONS_DIR)
  // The partition check looks for this month and next; a fresh schema has only
  // the catch-all until something creates them.
  const now = new Date()
  for (const offset of [0, 1]) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    await db.pool.query('SELECT ensure_click_partition($1::date)', [month.toISOString().slice(0, 10)])
  }
  return db
}

function withSslMode(url, mode) {
  const parsed = new URL(url)
  parsed.searchParams.set('sslmode', mode)
  return parsed.toString()
}

function find(results, name) {
  const hit = results.find((r) => r.name === name)
  assert.ok(hit, `no check named "${name}" in: ${results.map((r) => r.name).join(', ')}`)
  return hit
}

async function runCli(overrides) {
  const env = { ...process.env }
  // A DATABASE_URL or PGOPTIONS inherited from the shell would silently decide
  // the outcome of the exit-code tests.
  for (const key of ['DATABASE_URL', 'PGOPTIONS', 'PGSSLMODE']) delete env[key]
  Object.assign(env, overrides)

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DOCTOR], { env, timeout: 60_000 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('a healthy installation passes every check', async (t) => {
  const db = await ready('doctor_happy')
  t.after(() => db.end())

  const { ok, results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_happy',
    probes: HAPPY_PROBES,
  })

  const failures = results.filter((r) => !r.ok)
  assert.deepEqual(failures, [], 'a freshly migrated installation must be clean')
  assert.equal(ok, true)
  for (const name of ['database', 'migrations', 'clock', 'subdomains', 'partitions', 'retention']) {
    assert.equal(find(results, name).ok, true)
  }
})

test('an unreachable database fails and stops the run', async () => {
  const { ok, results } = await runChecks({
    databaseUrl: 'postgres://localhost:1/linkyard_absent',
    probes: HAPPY_PROBES,
  })

  assert.equal(ok, false)
  assert.equal(results.length, 1, 'nothing else is knowable without a connection')
  assert.equal(find(results, 'database').ok, false)
  assert.ok(find(results, 'database').next, 'a failing check must carry a next step')
})

test('a connection string demanding TLS from a server that refuses it names the exact fix', async () => {
  const { ok, results } = await runChecks({
    databaseUrl: withSslMode(TEST_URL, 'require'),
    probes: HAPPY_PROBES,
  })

  assert.equal(ok, false)
  const database = find(results, 'database')
  assert.equal(database.ok, false)
  assert.match(database.detail, /refuses/i)
  assert.match(database.next, /sslmode/)
  assert.match(database.next, /plain TCP/i, 'the Railway private network is the reason this happens')
})

test('credentials carried as query parameters are understood', async (t) => {
  const db = await ready('doctor_qs')
  t.after(() => db.end())

  // The shape docker-compose.yml and railway-template.json both produce: user
  // and password as query parameters rather than as user:password@host.
  // The user comes out of TEST_URL rather than the environment: CI connects as
  // the `postgres` role while a laptop connects as its login name, and a query
  // parameter overrides the URL's own username.
  const url = new URL(TEST_URL)
  const user = url.username || process.env.PGUSER || process.env.USER
  if (user) url.searchParams.set('user', user)

  const { results } = await runChecks({
    databaseUrl: url.toString(),
    schema: 'doctor_qs',
    probes: HAPPY_PROBES,
  })

  assert.equal(find(results, 'database').ok, true)
})

test('a missing migration is reported by version', async (t) => {
  const db = await ready('doctor_behind')
  t.after(() => db.end())

  await db.pool.query(`DELETE FROM schema_migrations WHERE version = '005_soft_delete'`)

  const { ok, results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_behind',
    probes: HAPPY_PROBES,
  })

  assert.equal(ok, false)
  const migrations = find(results, 'migrations')
  assert.equal(migrations.ok, false)
  assert.match(migrations.detail, /005_soft_delete/)
})

test('a database ahead of the checkout is a failure, not a pass', async (t) => {
  const db = await ready('doctor_ahead')
  t.after(() => db.end())

  await db.pool.query(`INSERT INTO schema_migrations (version) VALUES ('999_from_a_newer_release')`)

  const { results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_ahead',
    probes: HAPPY_PROBES,
  })

  const migrations = find(results, 'migrations')
  assert.equal(migrations.ok, false, 'running old code against a newer schema breaks in silent ways')
  assert.match(migrations.detail, /999_from_a_newer_release/)
})

test('a missing partition for this month or next is a failure', async (t) => {
  const db = await freshDatabase('doctor_parts')
  t.after(() => db.end())
  await migrate(db.pool, MIGRATIONS_DIR)

  const { results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_parts',
    probes: HAPPY_PROBES,
  })

  const partitions = find(results, 'partitions')
  assert.equal(partitions.ok, false)
  assert.match(partitions.detail, /click_events_\d{4}_\d{2}/)
  assert.match(partitions.next, /ensure_click_partition/)
})

test('a partition older than the retention window means the purge never ran', async (t) => {
  const db = await ready('doctor_retention')
  t.after(() => db.end())

  await db.pool.query(`SELECT ensure_click_partition('2020-01-01'::date)`)

  const { results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_retention',
    probes: HAPPY_PROBES,
  })

  const retention = find(results, 'retention')
  assert.equal(retention.ok, false)
  assert.match(retention.detail, /2020_01/)
  assert.match(retention.detail, /180/, 'the configured window belongs in the report')
})

test('an unmigrated database is reported, not crashed on', async (t) => {
  const db = await freshDatabase('doctor_empty')
  t.after(() => db.end())

  const { ok, results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_empty',
    probes: HAPPY_PROBES,
  })

  assert.equal(ok, false)
  const migrations = find(results, 'migrations')
  assert.equal(migrations.ok, false)
  assert.match(migrations.detail, /never been migrated/)
  assert.equal(
    results.some((r) => ['subdomains', 'partitions', 'retention'].includes(r.name)),
    false,
    'checks that read product tables cannot say anything useful before the tables exist'
  )
})

test('an unexpected database error becomes a finding, not a stack trace', async (t) => {
  const db = await ready('doctor_broken')
  t.after(() => db.end())

  // A table missing while the ledger still claims it was applied is the shape
  // of every "someone ran something by hand" incident.
  await db.pool.query('DROP TABLE subdomains CASCADE')

  const { ok, results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_broken',
    probes: HAPPY_PROBES,
  })

  assert.equal(ok, false)
  const subdomains = find(results, 'subdomains')
  assert.equal(subdomains.ok, false)
  assert.match(subdomains.detail, /subdomains/)
  assert.ok(find(results, 'partitions'), 'one broken check must not cancel the rest')
})

test('clock drift beyond the tolerance fails, because a swap fires on the database clock', async (t) => {
  const db = await ready('doctor_clock')
  t.after(() => db.end())

  const { results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_clock',
    probes: HAPPY_PROBES,
    // The local clock is the database clock here, so the drift is forced by
    // shrinking the tolerance rather than by moving anybody's time.
    clockToleranceMs: -1,
  })

  const clock = find(results, 'clock')
  assert.equal(clock.ok, false)
  assert.match(clock.next, /NTP/)
})

test('each active subdomain is checked for DNS, certificate and health', async (t) => {
  const db = await ready('doctor_hosts')
  t.after(() => db.end())

  const { rows: domain } = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  await db.pool.query(
    `INSERT INTO subdomains (domain_id, host, record_type, record_value)
     VALUES ($1, 'go.example.com', 'CNAME', 'edge.up.railway.app')`,
    [domain[0].id]
  )

  const { results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_hosts',
    probes: {
      async resolveHost() {
        return { ok: false, error: 'NXDOMAIN' }
      },
      async inspectCertificate() {
        return { ok: true, authorized: false, daysRemaining: -3, authorizationError: 'CERT_HAS_EXPIRED' }
      },
      async fetchHealth() {
        return { ok: false, status: 502 }
      },
    },
  })

  const dns = find(results, 'dns go.example.com')
  assert.equal(dns.ok, false)
  assert.match(dns.next, /CNAME/)
  assert.match(dns.next, /edge\.up\.railway\.app/, 'the record the panel already recorded is the fix')

  assert.equal(find(results, 'certificate go.example.com').ok, false)
  assert.equal(find(results, 'health go.example.com').ok, false)
})

test('an inactive subdomain is not reported as broken', async (t) => {
  const db = await ready('doctor_inactive')
  t.after(() => db.end())

  const { rows: domain } = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  await db.pool.query(
    `INSERT INTO subdomains (domain_id, host, active) VALUES ($1, 'old.example.com', false)`,
    [domain[0].id]
  )

  const { results } = await runChecks({
    databaseUrl: TEST_URL,
    schema: 'doctor_inactive',
    probes: HAPPY_PROBES,
  })

  assert.equal(
    results.some((r) => r.name.includes('old.example.com')),
    false,
    'a subdomain the operator turned off is not a fault'
  )
})

// The three that matter for the exit code. Everything above proves the checks
// see the right thing; these prove the process tells a shell script about it.

test('the CLI exits non-zero when a check fails', async () => {
  const { code, stdout } = await runCli({ DATABASE_URL: 'postgres://localhost:1/linkyard_absent' })

  assert.notEqual(code, 0, 'a failing diagnostic must be visible to CI and to `&&`')
  assert.match(stdout, /FAIL/)
})

test('the CLI exits non-zero when DATABASE_URL is missing entirely', async () => {
  const { code } = await runCli({})
  assert.notEqual(code, 0)
})

test('the CLI exits zero on a healthy installation', async (t) => {
  const db = await ready('doctor_cli_ok')
  t.after(() => db.end())

  const { code, stdout, stderr } = await runCli({
    DATABASE_URL: TEST_URL,
    PGOPTIONS: '-c search_path=doctor_cli_ok,public',
  })

  assert.equal(code, 0, `doctor rejected a healthy installation:\n${stdout}\n${stderr}`)
  assert.match(stdout, /PASS/)
  assert.doesNotMatch(stdout, /FAIL/)
})
