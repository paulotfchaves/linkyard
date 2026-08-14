import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import type { Pool } from 'pg'
import { Secret } from '@linkyard/core/secret'
import { CloudflareDns } from '../app/lib/dns/cloudflare.ts'
import { RailwayInfra } from '../app/lib/infra/railway.ts'
import {
  advanceProvision,
  connectDnsCredential,
  discardProvision,
  getPendingProvision,
  loadDnsCredential,
  startProvision,
} from '../app/lib/provisioning.server.ts'
import { closePool, query } from '../app/lib/db.server.ts'

// The whole provider stack runs for real here — CloudflareDns and RailwayInfra,
// not stand-ins — over a fake fetch that behaves like the two APIs. A test
// against fake providers would prove the guards call the right methods; this
// one proves what actually goes on the wire, which is where `proxied: true` and
// a missing TXT record would show up.

const load = (path: string) => import(new URL(path, import.meta.url).href)

const { freshDatabase, TEST_URL } = (await load('../../db/test-support/helpers.mjs')) as {
  freshDatabase: (schemaName: string) => Promise<TestDatabase>
  TEST_URL: string
}
const { migrate } = (await load('../../db/migrate.mjs')) as {
  migrate: (pool: Pool, dir?: string) => Promise<string[]>
}

type TestDatabase = { pool: Pool; schemaName: string; end: () => Promise<void> }

const SCHEMA = 'provisioning_test'

const ZONE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OTHER_ZONE = '0f9e8d7c6b5a493827160f5e4d3c2b1a'
const TOKEN_ID = 'ffffffffffffffffffffffffffffffff'
const CF_TOKEN = 'cf-token-sentinel-value'
const RAILWAY_TOKEN = 'railway-token-sentinel-value'
const APEX = 'example.com'
const HOST = 'go.example.com'
const CNAME_TARGET = 'hwvk639a.up.railway.app'

let db: TestDatabase
let userId: string
const realFetch = globalThis.fetch

// ------------------------------------------------------------- the fake world

type CfRecordRow = { id: string; type: string; name: string; content: string; proxied: boolean }
type RailwayDomain = {
  id: string
  domain: string
  certificateStatus: string
  verificationToken: string | null
  verificationDnsHost: string | null
  cname: string
}

type World = {
  zoneScope: string[] | 'all'
  tokenDetailForbidden: boolean
  records: CfRecordRow[]
  railwayDomains: RailwayDomain[]
  healthy: boolean
  writes: { method: string; url: string; body: Record<string, unknown> | null }[]
  healthProbes: string[]
}

let world: World

function freshWorld(overrides: Partial<World> = {}): World {
  return {
    zoneScope: [ZONE],
    tokenDetailForbidden: false,
    records: [],
    railwayDomains: [],
    healthy: true,
    writes: [],
    healthProbes: [],
    ...overrides,
  }
}

let recordSeq = 0

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function cfOk(result: unknown, extra: Record<string, unknown> = {}): Response {
  return json({ success: true, result, errors: [], ...extra })
}

function cfFail(message: string, status = 400): Response {
  return json({ success: false, result: null, errors: [{ code: 1000, message }] }, status)
}

function policiesFor(zones: string[] | 'all'): unknown[] {
  if (zones === 'all') {
    return [
      {
        effect: 'allow',
        resources: {
          'com.cloudflare.api.account.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
            'com.cloudflare.api.account.zone.*': '*',
          },
        },
        permission_groups: [{ name: 'DNS Write' }, { name: 'Zone Read' }],
      },
    ]
  }
  return zones.map((zoneId) => ({
    effect: 'allow',
    resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: '*' },
    permission_groups: [{ name: 'DNS Write' }, { name: 'Zone Read' }],
  }))
}

function cloudflare(url: URL, method: string, body: Record<string, unknown> | null): Response {
  const path = url.pathname.replace('/client/v4', '')

  if (path === '/user/tokens/verify') {
    return cfOk({ id: TOKEN_ID, status: 'active', expires_on: null })
  }
  if (path === `/user/tokens/${TOKEN_ID}`) {
    if (world.tokenDetailForbidden) return cfFail('Unauthorized to access requested resource', 403)
    return cfOk({
      id: TOKEN_ID,
      status: 'active',
      expires_on: null,
      policies: policiesFor(world.zoneScope),
    })
  }
  if (path === '/zones') {
    const ids = world.zoneScope === 'all' ? [ZONE, OTHER_ZONE] : world.zoneScope
    const zones = ids.map((id) => ({
      id,
      name: id === ZONE ? APEX : 'other.example',
      account: { id: 'acct', name: 'Personal' },
    }))
    return cfOk(zones, { result_info: { page: 1, total_pages: 1 } })
  }

  const recordsPath = `/zones/${ZONE}/dns_records`
  if (path === recordsPath && method === 'GET') {
    const name = url.searchParams.get('name') ?? ''
    return cfOk(world.records.filter((record) => record.name === name))
  }
  if (path === recordsPath && method === 'POST') {
    const created: CfRecordRow = {
      id: `rec${(recordSeq += 1)}`,
      type: String(body?.type ?? ''),
      name: String(body?.name ?? ''),
      content: String(body?.content ?? ''),
      proxied: body?.proxied === true,
    }
    world.records.push(created)
    return cfOk({ ...created, ttl: 1 })
  }
  if (path.startsWith(`${recordsPath}/`) && method === 'DELETE') {
    const id = path.slice(recordsPath.length + 1)
    world.records = world.records.filter((record) => record.id !== id)
    return cfOk({ id })
  }

  return cfFail('no route', 404)
}

function railway(body: Record<string, unknown> | null): Response {
  const text = String(body?.query ?? '')
  const variables = (body?.variables ?? {}) as Record<string, any>

  if (text.includes('customDomainCreate')) {
    const host = String(variables.input?.domain ?? '')
    if (world.railwayDomains.some((domain) => domain.domain === host)) {
      return json({ data: null, errors: [{ message: 'Domain already exists' }] })
    }
    const created: RailwayDomain = {
      id: `cd-${world.railwayDomains.length + 1}`,
      domain: host,
      certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP',
      verificationToken: 'verify-me-1234',
      verificationDnsHost: `_railway-verify.${host}`,
      cname: CNAME_TARGET,
    }
    world.railwayDomains.push(created)
    return json({ data: { customDomainCreate: shapeDomain(created) } })
  }

  if (text.includes('customDomainDelete')) {
    world.railwayDomains = world.railwayDomains.filter((domain) => domain.id !== variables.id)
    return json({ data: { customDomainDelete: true } })
  }

  if (text.includes('domains(')) {
    return json({
      data: { domains: { customDomains: world.railwayDomains.map(shapeDomain) } },
    })
  }

  return json({ data: null, errors: [{ message: 'unknown operation' }] })
}

function shapeDomain(domain: RailwayDomain) {
  return {
    id: domain.id,
    domain: domain.domain,
    status: {
      certificateStatus: domain.certificateStatus,
      verificationToken: domain.verificationToken,
      verificationDnsHost: domain.verificationDnsHost,
      dnsRecords: [{ recordType: 'CNAME', requiredValue: domain.cname }],
    },
  }
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null

    if (method !== 'GET') world.writes.push({ method, url: url.toString(), body })

    if (url.hostname === 'api.cloudflare.com') return cloudflare(url, method, body)
    if (url.hostname === 'backboard.railway.com') return railway(body)
    if (url.pathname === '/healthz') {
      world.healthProbes.push(url.hostname)
      return world.healthy ? new Response('ok', { status: 200 }) : new Response('', { status: 502 })
    }
    throw new TypeError(`unexpected request to ${url.toString()}`)
  }) as typeof fetch
}

function dns(): CloudflareDns {
  return new CloudflareDns(new Secret(CF_TOKEN))
}

function infra(): RailwayInfra {
  return new RailwayInfra({
    token: new Secret(RAILWAY_TOKEN),
    projectId: 'proj',
    environmentId: 'env',
    serviceId: 'svc',
    targetPort: 8080,
  })
}

function deps() {
  return { dns: dns(), infra: infra() }
}

async function begin(prefix = 'go') {
  return startProvision(
    { userId, credentialId: null, zoneId: ZONE, prefix },
    { dns: dns() }
  )
}

/** Runs the flow to completion, or stops at the first step that does not advance. */
async function runToEnd(jobId: string, options: { overwriteCname?: boolean } = {}) {
  let last = await advanceProvision(jobId, deps(), options)
  for (let step = 0; step < 8 && last.status === 'advanced'; step += 1) {
    last = await advanceProvision(jobId, deps(), options)
  }
  return last
}

// ------------------------------------------------------------------- fixtures

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`
  process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef'

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('olivia', 'olivia@example.com', 'not-a-real-hash', 'owner') RETURNING id`
  )
  userId = rows[0].id
})

after(async () => {
  globalThis.fetch = realFetch
  await closePool()
  await db.end()
})

beforeEach(async () => {
  world = freshWorld()
  installFetch()
  await db.pool.query('DELETE FROM audit_log')
  await db.pool.query('DELETE FROM subdomains')
  await db.pool.query('DELETE FROM domains')
  await db.pool.query('DELETE FROM credentials')
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ------------------------------------------------------------- the scope gate

describe('the scope gate', () => {
  it('refuses an all-zones token and creates no job', async () => {
    world.zoneScope = 'all'

    const result = await begin()

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.code, 'scope')
    assert.equal(
      result.ok === false && result.code === 'scope' && result.verdict.ok === false
        ? result.verdict.reason
        : null,
      'all_zones'
    )
    const jobs = await query('SELECT id FROM audit_log')
    assert.equal(jobs.length, 0, 'a refused token must not leave a job behind')
  })

  it('refuses a token that also reaches other zones', async () => {
    world.zoneScope = [ZONE, OTHER_ZONE]

    const result = await begin()

    assert.equal(result.ok === false && result.code, 'scope')
  })

  it('blocks the DNS write even when a job already exists', async () => {
    // Credentials can be replaced between steps of a resumable job, so the gate
    // is enforced again at the only moment that matters: before the write.
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())

    world.zoneScope = 'all'
    const blocked = await advanceProvision(started.job.id, deps())

    assert.equal(blocked.status, 'blocked')
    assert.equal(world.records.length, 0, 'nothing may be written under a broad token')
  })

  it('accepts a scope inferred from the zone listing when the policy is unreadable', async () => {
    world.tokenDetailForbidden = true

    const result = await begin()

    assert.equal(result.ok, true)
  })
})

// ------------------------------------------------------------ starting a job

describe('startProvision', () => {
  it('refuses a prefix that is not a DNS label', async () => {
    for (const prefix of ['', 'go.links', 'UP PER', '-lead', 'trail-', 'x'.repeat(64)]) {
      const result = await begin(prefix)
      assert.equal(result.ok, false, `${prefix} must be refused`)
      assert.equal(result.ok === false && result.code, 'invalid_prefix')
    }
  })

  it('refuses a host that already exists in this installation', async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO domains (apex) VALUES ($1) RETURNING id`,
      [APEX]
    )
    await db.pool.query(`INSERT INTO subdomains (domain_id, host) VALUES ($1, $2)`, [
      rows[0].id,
      HOST,
    ])

    const result = await begin()

    assert.equal(result.ok === false && result.code, 'host_taken')
  })

  it('allows a second host under a domain that is already connected', async () => {
    // Linkyard's model is one domain with many hosts, so an apex already in the
    // table is a reason to reuse its row — never a reason to refuse.
    await db.pool.query(`INSERT INTO domains (apex) VALUES ($1)`, [APEX])

    const result = await begin('links')

    assert.equal(result.ok, true)
    assert.equal(result.ok && result.job.input.host, 'links.example.com')
  })

  it('allows only one provision at a time', async () => {
    const first = await begin()
    assert.ok(first.ok)

    const second = await begin('links')

    assert.equal(second.ok === false && second.code, 'locked')
    assert.equal(second.ok === false && second.code === 'locked' && second.host, HOST)
  })

  it('releases a job abandoned more than thirty minutes ago', async () => {
    const first = await begin()
    assert.ok(first.ok)
    await db.pool.query(
      `UPDATE audit_log SET occurred_at = now() - interval '31 minutes' WHERE id = $1`,
      [first.job.id]
    )

    const second = await begin('links')

    assert.equal(second.ok, true)
    const stale = await query<{ state: string }>(
      `SELECT after->>'state' AS state FROM audit_log WHERE id = $1`,
      [first.job.id]
    )
    assert.equal(stale[0].state, 'abandoned')
  })
})

// -------------------------------------------------------------- the happy path

describe('a complete provision', () => {
  it('writes both records, waits for the certificate, and records the host', async () => {
    const started = await begin()
    assert.ok(started.ok)
    const jobId = started.job.id

    const afterInfra = await advanceProvision(jobId, deps())
    assert.equal(afterInfra.status, 'advanced')
    assert.equal(afterInfra.job.cnameTarget, CNAME_TARGET)

    const afterDns = await advanceProvision(jobId, deps())
    assert.equal(afterDns.status, 'advanced')

    // The TXT is the record this project lost hours to. Without it the
    // certificate never leaves VALIDATING_OWNERSHIP and nothing says why.
    const cname = world.records.find((record) => record.type === 'CNAME')
    const txt = world.records.find((record) => record.type === 'TXT')
    assert.ok(cname, 'the CNAME must be written')
    assert.ok(txt, 'the ownership TXT must be written')
    assert.equal(cname?.content, CNAME_TARGET)
    assert.equal(txt?.name, `_railway-verify.${HOST}`)
    assert.equal(txt?.content, 'verify-me-1234')

    // Still validating: the certificate must not read as ready.
    const waiting = await advanceProvision(jobId, deps())
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.status === 'waiting' && waiting.reason, 'certificate')

    world.railwayDomains[0].certificateStatus = 'CERTIFICATE_STATUS_TYPE_VALID'
    const afterCert = await advanceProvision(jobId, deps())
    assert.equal(afterCert.status, 'advanced')
    assert.deepEqual(world.healthProbes, [HOST], 'the host is asked directly, not taken on trust')

    const finished = await advanceProvision(jobId, deps())
    assert.equal(finished.status, 'done')

    const domains = await query<{ id: string; apex: string; dns_zone_id: string; verified_at: Date }>(
      'SELECT id, apex, dns_zone_id, verified_at FROM domains'
    )
    assert.equal(domains.length, 1)
    assert.equal(domains[0].apex, APEX)
    assert.equal(domains[0].dns_zone_id, ZONE)
    assert.ok(domains[0].verified_at)

    const hosts = await query<{
      host: string
      record_type: string
      record_value: string
      cert_status: string
      infra_host_id: string
    }>('SELECT host, record_type, record_value, cert_status, infra_host_id FROM subdomains')
    assert.equal(hosts.length, 1)
    assert.deepEqual(
      {
        host: hosts[0].host,
        record_type: hosts[0].record_type,
        record_value: hosts[0].record_value,
        cert_status: hosts[0].cert_status,
        infra_host_id: hosts[0].infra_host_id,
      },
      {
        host: HOST,
        record_type: 'CNAME',
        record_value: CNAME_TARGET,
        cert_status: 'valid',
        infra_host_id: 'cd-1',
      }
    )
  })

  it('never asks Cloudflare to proxy anything it writes', async () => {
    // The orange cloud terminates TLS at Cloudflare, and the certificate then
    // never issues. This assertion reads the body that actually left.
    const started = await begin()
    assert.ok(started.ok)
    await runToEnd(started.job.id)

    const creates = world.writes.filter((write) => write.url.includes('/dns_records'))
    assert.ok(creates.length >= 2)
    for (const write of creates) {
      assert.equal(write.body?.proxied, false, `${String(write.body?.name)} was written proxied`)
    }
    assert.ok(world.records.every((record) => record.proxied === false))
  })

  it('waits while the host answers nothing, even with a valid certificate', async () => {
    world.healthy = false
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())
    await advanceProvision(started.job.id, deps())
    world.railwayDomains[0].certificateStatus = 'CERTIFICATE_STATUS_TYPE_VALID'

    const result = await advanceProvision(started.job.id, deps())

    assert.equal(result.status, 'waiting')
    assert.equal(result.status === 'waiting' && result.reason, 'propagating')
  })

  it('stops when the certificate fails', async () => {
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())
    await advanceProvision(started.job.id, deps())
    world.railwayDomains[0].certificateStatus = 'CERTIFICATE_STATUS_TYPE_ISSUE_FAILED'

    const result = await advanceProvision(started.job.id, deps())

    assert.equal(result.status, 'failed')
    assert.equal(await getPendingProvision().then((job) => job), null)
  })
})

// ---------------------------------------------------------------- the guards

describe('record guards', () => {
  it('stops hard on an A record at the host', async () => {
    world.records.push({
      id: 'existing-a',
      type: 'A',
      name: HOST,
      content: '203.0.113.10',
      proxied: false,
    })
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())

    const result = await advanceProvision(started.job.id, deps())

    assert.equal(result.status, 'conflict')
    assert.equal(result.status === 'conflict' && result.conflict.kind, 'address_record')
    assert.equal(result.status === 'conflict' && result.conflict.safeToOverwrite, false)
    assert.equal(world.records.length, 1, 'the existing record must still be the only one')
  })

  it('refuses to touch a CNAME that points somewhere else entirely', async () => {
    world.records.push({
      id: 'existing-cname',
      type: 'CNAME',
      name: HOST,
      content: 'shop.myshopify.com',
      proxied: false,
    })
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())

    const result = await advanceProvision(started.job.id, deps(), { overwriteCname: true })

    assert.equal(result.status, 'conflict')
    assert.equal(result.status === 'conflict' && result.conflict.kind, 'foreign_cname')
    assert.equal(
      result.status === 'conflict' && result.conflict.safeToOverwrite,
      false,
      'a record we did not create is never overwritable, confirmed or not'
    )
    assert.equal(world.records[0].content, 'shop.myshopify.com')
  })

  it('asks before replacing a stale record of our own, then replaces it', async () => {
    world.records.push({
      id: 'stale',
      type: 'CNAME',
      name: HOST,
      content: 'old-service.up.railway.app',
      proxied: false,
    })
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())

    const asked = await advanceProvision(started.job.id, deps())
    assert.equal(asked.status, 'conflict')
    assert.equal(asked.status === 'conflict' && asked.conflict.kind, 'stale_cname')
    assert.equal(asked.status === 'conflict' && asked.conflict.safeToOverwrite, true)
    assert.equal(world.records[0].content, 'old-service.up.railway.app', 'unconfirmed changes nothing')

    const confirmed = await advanceProvision(started.job.id, deps(), { overwriteCname: true })

    assert.equal(confirmed.status, 'advanced')
    const cnames = world.records.filter((record) => record.type === 'CNAME')
    assert.equal(cnames.length, 1)
    assert.equal(cnames[0].content, CNAME_TARGET)
  })

  it('repairs a record of ours that is correct but proxied', async () => {
    world.records.push({
      id: 'proxied',
      type: 'CNAME',
      name: HOST,
      content: CNAME_TARGET,
      proxied: true,
    })
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())

    const result = await advanceProvision(started.job.id, deps())

    assert.equal(result.status, 'advanced')
    const cnames = world.records.filter((record) => record.type === 'CNAME')
    assert.equal(cnames.length, 1)
    assert.equal(cnames[0].proxied, false)
  })
})

// --------------------------------------------------------------- resumability

describe('resuming', () => {
  it('is idempotent: a repeated DNS step writes nothing twice', async () => {
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())
    await advanceProvision(started.job.id, deps())
    const afterFirst = world.records.length

    // Force the step to run again, as an interrupted job would.
    await db.pool.query(
      `UPDATE audit_log SET after = jsonb_set(after, '{steps,dns}', '"pending"') WHERE id = $1`,
      [started.job.id]
    )
    const again = await advanceProvision(started.job.id, deps())

    assert.equal(again.status, 'advanced')
    assert.equal(world.records.length, afterFirst, 'the same two records, not four')
  })

  it('adopts the host it already created at the provider', async () => {
    const started = await begin()
    assert.ok(started.ok)
    await advanceProvision(started.job.id, deps())

    await db.pool.query(
      `UPDATE audit_log SET after = jsonb_set(after, '{steps,infra}', '"pending"') WHERE id = $1`,
      [started.job.id]
    )
    const again = await advanceProvision(started.job.id, deps())

    assert.equal(again.status, 'advanced')
    assert.equal(again.job.reusedHost, true)
    assert.equal(world.railwayDomains.length, 1, 'no second custom domain at the provider')
  })

  it('reports the job in flight so a reload can pick it up', async () => {
    const started = await begin()
    assert.ok(started.ok)

    const pending = await getPendingProvision()

    assert.equal(pending?.id, started.job.id)
    assert.equal(pending?.input.host, HOST)
    assert.equal(pending?.steps.infra, 'pending')
  })

  it('releases the lock when a job is discarded', async () => {
    const started = await begin()
    assert.ok(started.ok)

    await discardProvision(started.job.id)

    assert.equal(await getPendingProvision(), null)
    const next = await begin('links')
    assert.equal(next.ok, true)
  })
})

// ---------------------------------------------------------------- credentials

describe('credentials', () => {
  it('stores the token sealed and never in the clear', async () => {
    const connected = await connectDnsCredential({
      label: 'Personal Cloudflare',
      token: new Secret(CF_TOKEN),
      userId,
    })
    assert.equal(connected.ok, true)

    const rows = await query<{ ciphertext: Buffer; last4: string; scopes: unknown }>(
      'SELECT ciphertext, last4, scopes FROM credentials'
    )
    assert.equal(rows.length, 1)
    assert.ok(!rows[0].ciphertext.toString('utf8').includes(CF_TOKEN))
    assert.ok(!JSON.stringify(rows[0].scopes).includes(CF_TOKEN))
    assert.equal(rows[0].last4, CF_TOKEN.slice(-4))
  })

  it('opens the stored token back into a working provider', async () => {
    const connected = await connectDnsCredential({
      label: 'Personal Cloudflare',
      token: new Secret(CF_TOKEN),
      userId,
    })
    assert.ok(connected.ok)

    const loaded = await loadDnsCredential(connected.credential.id)
    const zones = await loaded.provider.listZones()

    assert.deepEqual(
      zones.map((zone) => zone.name),
      [APEX]
    )
  })
})
