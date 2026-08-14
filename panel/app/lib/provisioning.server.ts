import { Secret } from '@linkyard/core/secret'
import { deriveKey, last4, open, seal } from '@linkyard/core/vault'
import { query, queryOne, transaction } from './db.server.ts'
import { CloudflareDns, assertZoneScope, type ScopeVerdict } from './dns/cloudflare.ts'
import { RailwayInfra } from './infra/railway.ts'
import {
  ProviderError,
  sameHost,
  type CertStatus,
  type DnsProvider,
  type InfraProvider,
  type TokenScope,
  type VerificationRecord,
} from './infra/types.ts'

// Connecting a domain, end to end.
//
// Four steps — host at the infrastructure provider, DNS records, certificate,
// then the rows this panel reads — each of which can fail on its own and be
// picked up again later. The design constraint that shapes everything here is
// that the operator closes the tab. A certificate takes minutes; a DNS record
// takes as long as the previous TTL says it takes; and somewhere in the middle
// somebody's laptop goes to sleep. So there is no in-memory state at all: every
// step reads where it got to from the database, does one thing, and writes back
// where it got to.
//
// The guards are ported from a system that ran this in production for two
// years. Each one exists because of an outage:
//
//   - A record at the host is a hard stop. Somebody's website lives there.
//   - A CNAME we did not create is never overwritten. Same reason, and the old
//     value is gone the moment we write over it.
//   - Records are written DNS-only. The orange cloud terminates TLS at
//     Cloudflare and the certificate then never issues.
//   - One provision at a time. Two certificates validating at once against the
//     same zone is how you get two failures instead of one success.

const JOB_ACTION = 'domain_provision'

// Long enough that a slow certificate is never mistaken for an abandoned tab,
// short enough that a crashed job does not lock the panel for an afternoon.
const LOCK_TTL_MS = 30 * 60 * 1000

const HEALTH_TIMEOUT_MS = 8_000

// One DNS label: 1–63 characters, alphanumeric with interior hyphens.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export type ProvisionStepKey = 'infra' | 'dns' | 'certificate' | 'record'
export type StepState = 'pending' | 'ok'
export type ProvisionState = 'in_progress' | 'done' | 'error' | 'abandoned'

export type ProvisionInput = {
  userId: string | null
  credentialId: string | null
  zoneId: string
  zoneName: string
  prefix: string
  host: string
}

export type ProvisionJob = {
  id: string
  startedAt: Date
  state: ProvisionState
  input: ProvisionInput
  steps: Record<ProvisionStepKey, StepState>
  hostId: string | null
  cnameTarget: string | null
  verification: VerificationRecord | null
  reusedHost: boolean
  certificate: CertStatus | null
  domainId: string | null
  subdomainId: string | null
  error: string | null
}

type JobDocument = Omit<ProvisionJob, 'id' | 'startedAt'>

type JobRow = { id: string; occurred_at: Date; after: JobDocument }

const JOB_COLUMNS = `id::text AS id, occurred_at, after`

function toJob(row: JobRow): ProvisionJob {
  return { id: row.id, startedAt: row.occurred_at, ...row.after }
}

function isJobId(value: string): boolean {
  return /^[0-9]{1,19}$/.test(value)
}

async function loadJob(jobId: string): Promise<ProvisionJob | null> {
  if (!isJobId(jobId)) return null
  const row = await queryOne<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM audit_log WHERE id = $1::bigint AND action = $2`,
    [jobId, JOB_ACTION]
  )
  return row ? toJob(row) : null
}

async function inFlightJobs(): Promise<ProvisionJob[]> {
  const rows = await query<JobRow>(
    `SELECT ${JOB_COLUMNS}
       FROM audit_log
      WHERE action = $1 AND after->>'state' = 'in_progress'
      ORDER BY occurred_at DESC, id DESC
      LIMIT 10`,
    [JOB_ACTION]
  )
  return rows.map(toJob)
}

/** Writes the document back whole. A job is small and the alternative is a jsonb patch language. */
async function save(job: ProvisionJob, patch: Partial<JobDocument>): Promise<ProvisionJob> {
  const next: ProvisionJob = { ...job, ...patch, steps: { ...job.steps, ...patch.steps } }
  // id and startedAt are columns, not document fields, so they are listed out
  // rather than spread: a document carrying its own stale copy of the row's
  // identity is a bug waiting for the first time the two disagree.
  const document: JobDocument = {
    state: next.state,
    input: next.input,
    steps: next.steps,
    hostId: next.hostId,
    cnameTarget: next.cnameTarget,
    verification: next.verification,
    reusedHost: next.reusedHost,
    certificate: next.certificate,
    domainId: next.domainId,
    subdomainId: next.subdomainId,
    error: next.error,
  }
  await query(
    `UPDATE audit_log
        SET after = $2::jsonb,
            entity_id = COALESCE($3::uuid, entity_id)
      WHERE id = $1::bigint`,
    [next.id, JSON.stringify(document), next.domainId]
  )
  return next
}

async function fail(job: ProvisionJob, detail: string): Promise<ProvisionJob> {
  return save(job, { state: 'error', error: detail })
}

// ------------------------------------------------------------------- starting

export type StartResult =
  | { ok: true; job: ProvisionJob }
  | { ok: false; code: 'invalid_prefix' }
  | { ok: false; code: 'locked'; host: string }
  | { ok: false; code: 'host_taken'; host: string }
  | { ok: false; code: 'zone_unreachable' }
  | { ok: false; code: 'scope'; verdict: ScopeVerdict; scope: TokenScope }
  | { ok: false; code: 'provider'; detail: string }

export type StartParams = {
  userId: string | null
  credentialId: string | null
  zoneId: string
  prefix: string
}

/**
 * Take the lock and record the intent — no provider is written to yet.
 *
 * The in-progress row *is* the lock. There is no separate lock table because a
 * lock nobody can see is a lock nobody can release: this one shows up in the
 * panel as "a domain is being added", with the host it belongs to, and it can
 * be discarded from the same screen.
 */
export async function startProvision(
  params: StartParams,
  deps: { dns: DnsProvider; now?: () => Date }
): Promise<StartResult> {
  const now = deps.now ?? (() => new Date())
  const prefix = params.prefix.trim().toLowerCase()
  if (!LABEL.test(prefix)) return { ok: false, code: 'invalid_prefix' }

  const blocked = await claimLock(now())
  if (blocked) return blocked

  let scope: TokenScope
  let zoneName: string
  try {
    // The zone is resolved through the operator's own token rather than trusted
    // from the form: it proves the token can read the zone, and it is the only
    // source for the apex the host will sit under.
    const zones = await deps.dns.listZones()
    const zone = zones.find((candidate) => candidate.id === params.zoneId)
    if (!zone) return { ok: false, code: 'zone_unreachable' }
    zoneName = zone.name
    scope = await deps.dns.tokenScope()
  } catch (error) {
    return { ok: false, code: 'provider', detail: describe(error) }
  }

  const verdict = assertZoneScope(scope, params.zoneId)
  if (!verdict.ok) return { ok: false, code: 'scope', verdict, scope }

  const host = `${prefix}.${zoneName}`

  // The apex being connected already is not a refusal — one domain holds many
  // hosts in this model, and the second host is the normal case. The host
  // itself is unique, and that is what is checked.
  const taken = await queryOne<{ id: string }>(
    `SELECT id FROM subdomains WHERE lower(host) = lower($1)`,
    [host]
  )
  if (taken) return { ok: false, code: 'host_taken', host }

  const document: JobDocument = {
    state: 'in_progress',
    input: {
      userId: params.userId,
      credentialId: params.credentialId,
      zoneId: params.zoneId,
      zoneName,
      prefix,
      host,
    },
    steps: { infra: 'pending', dns: 'pending', certificate: 'pending', record: 'pending' },
    hostId: null,
    cnameTarget: null,
    verification: null,
    reusedHost: false,
    certificate: null,
    domainId: null,
    subdomainId: null,
    error: null,
  }

  const inserted = await queryOne<JobRow>(
    `INSERT INTO audit_log (actor_id, action, entity, after)
     VALUES ($1::uuid, $2, 'domain', $3::jsonb)
     RETURNING ${JOB_COLUMNS}`,
    [params.userId, JOB_ACTION, JSON.stringify(document)]
  )
  if (!inserted) return { ok: false, code: 'provider', detail: 'the job could not be recorded' }
  const job = toJob(inserted)

  // Two tabs can pass the lock check in the same instant. Without a DDL change
  // there is no atomic guard, so the tie is broken after the fact and always
  // the same way: the oldest job wins and the younger one stands down. Both
  // tabs then agree about which provision is running.
  const contenders = (await inFlightJobs())
    .filter((candidate) => now().getTime() - candidate.startedAt.getTime() < LOCK_TTL_MS)
    .sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || Number(a.id) - Number(b.id)
    )
  const winner = contenders[0]
  if (winner && winner.id !== job.id) {
    await save(job, { state: 'abandoned', error: 'another provision holds the lock' })
    return { ok: false, code: 'locked', host: winner.input.host }
  }

  return { ok: true, job }
}

/** Refuses when another job holds the lock; releases anything past the TTL on the way through. */
async function claimLock(now: Date): Promise<{ ok: false; code: 'locked'; host: string } | null> {
  for (const job of await inFlightJobs()) {
    if (now.getTime() - job.startedAt.getTime() < LOCK_TTL_MS) {
      return { ok: false, code: 'locked', host: job.input.host }
    }
    // Older than the TTL: the tab is gone. Released here rather than by a
    // background sweeper, because the only moment anybody cares is the moment
    // somebody else wants the lock.
    await save(job, { state: 'abandoned', error: 'abandoned after 30 minutes' })
  }
  return null
}

export async function getPendingProvision(): Promise<ProvisionJob | null> {
  const jobs = await inFlightJobs()
  return jobs[0] ?? null
}

export async function discardProvision(jobId: string): Promise<void> {
  const job = await loadJob(jobId)
  if (!job || job.state !== 'in_progress') return
  await save(job, { state: 'abandoned', error: 'discarded' })
}

// ------------------------------------------------------------------ advancing

export type DnsConflict =
  | { kind: 'address_record'; recordType: string; value: string; safeToOverwrite: false }
  | { kind: 'foreign_cname'; recordType: 'CNAME'; value: string; safeToOverwrite: false }
  | { kind: 'stale_cname'; recordType: 'CNAME'; value: string; safeToOverwrite: true }

export type AdvanceResult =
  | { status: 'advanced'; job: ProvisionJob }
  | { status: 'waiting'; job: ProvisionJob; reason: 'certificate' | 'propagating' }
  | { status: 'conflict'; job: ProvisionJob; conflict: DnsConflict }
  | { status: 'blocked'; job: ProvisionJob; verdict: ScopeVerdict }
  | { status: 'failed'; job: ProvisionJob; error: string }
  | { status: 'done'; job: ProvisionJob }
  | { status: 'gone' }

export type AdvanceDeps = {
  dns: DnsProvider
  infra: InfraProvider
  /** Overridden only by tests; production asks the host itself. */
  probe?: (host: string) => Promise<boolean>
}

export type AdvanceOptions = {
  /** Set only by an operator who has been shown the record that will be replaced. */
  overwriteCname?: boolean
}

function describe(error: unknown): string {
  if (error instanceof ProviderError) return error.detail ?? error.code
  // Never the caught object's own message: an HTTP client puts the request —
  // Authorization header included — inside the error it throws.
  return 'the provider could not be reached'
}

/**
 * Do the next thing this job needs, and only that.
 *
 * One step per call, so the caller — a form post, a poll, a retry after a
 * closed laptop — is the thing driving progress, and every intermediate state
 * is on disk rather than in a promise nobody is awaiting any more.
 */
export async function advanceProvision(
  jobId: string,
  deps: AdvanceDeps,
  options: AdvanceOptions = {}
): Promise<AdvanceResult> {
  const job = await loadJob(jobId)
  if (!job || job.state !== 'in_progress') return { status: 'gone' }

  if (job.steps.infra !== 'ok') return stepInfra(job, deps)
  if (job.steps.dns !== 'ok') return stepDns(job, deps, options)
  if (job.steps.certificate !== 'ok') return stepCertificate(job, deps)
  return stepRecord(job)
}

async function stepInfra(job: ProvisionJob, deps: AdvanceDeps): Promise<AdvanceResult> {
  try {
    const requirement = await deps.infra.ensureHost(job.input.host)
    const next = await save(job, {
      steps: { ...job.steps, infra: 'ok' },
      hostId: requirement.hostId,
      cnameTarget: requirement.value,
      verification: requirement.verification,
      reusedHost: requirement.reused,
    })
    return { status: 'advanced', job: next }
  } catch (error) {
    const detail = describe(error)
    return { status: 'failed', job: await fail(job, detail), error: detail }
  }
}

/** A TXT value comes back from some providers wrapped in quotes it was not written with. */
function unquote(value: string): string {
  return value.replace(/^"(.*)"$/s, '$1')
}

async function stepDns(
  job: ProvisionJob,
  deps: AdvanceDeps,
  options: AdvanceOptions
): Promise<AdvanceResult> {
  const { zoneId, host } = job.input
  const target = job.cnameTarget
  if (!target) return { status: 'failed', job: await fail(job, 'no target to point at'), error: 'no target' }

  // The gate, enforced here and not only at the start: a job outlives the
  // credential it began with, and this is the last moment before a write.
  let verdict: ScopeVerdict
  try {
    verdict = assertZoneScope(await deps.dns.tokenScope(), zoneId)
  } catch (error) {
    const detail = describe(error)
    return { status: 'failed', job: await fail(job, detail), error: detail }
  }
  if (!verdict.ok) return { status: 'blocked', job, verdict }

  try {
    const existing = await deps.dns.findRecords(zoneId, host)

    // An address record at the host means something else is served there. There
    // is no version of "we knew better" that ends well, so the flow stops and
    // says what it found.
    const address = existing.find((record) => record.type === 'A' || record.type === 'AAAA')
    if (address) {
      const conflict: DnsConflict = {
        kind: 'address_record',
        recordType: address.type,
        value: address.content,
        safeToOverwrite: false,
      }
      // The job ends here: there is nothing this flow can do about a record it
      // must not touch, and holding the lock open would block every other
      // domain while somebody goes to edit DNS by hand.
      return { status: 'conflict', job: await fail(job, `${address.type} record already at ${host}`), conflict }
    }

    const cname = existing.find((record) => record.type === 'CNAME')
    if (cname) {
      // Three different situations, and they were collapsed into two.
      //
      // `ours` is the record this job itself would have written — the only case
      // that needs no question at all. A value that merely LOOKS like the
      // provider is not ours: two Railway projects on one domain both produce
      // up.railway.app targets, and the suffix test let the second installation
      // overwrite the first one's record silently. It is still worth offering a
      // confirmed replacement, because the likeliest owner is an earlier
      // install of this same product. Anything else points at somebody's live
      // service and gets no dialog, because no dialog makes that recoverable.
      const ours = deps.infra.ownsRecordValue(cname.content, target)
      const replaceable = ours || deps.infra.looksLikeRailwayTarget(cname.content)

      if (!replaceable) {
        // Confirmation is not offered here on purpose. Overwriting this record
        // destroys the only copy of a value that points at somebody else's
        // service, and no dialog makes that recoverable.
        const conflict: DnsConflict = {
          kind: 'foreign_cname',
          recordType: 'CNAME',
          value: cname.content,
          safeToOverwrite: false,
        }
        const stopped = await fail(job, `a CNAME at ${host} points outside this installation`)
        return { status: 'conflict', job: stopped, conflict }
      }

      const correct = sameHost(cname.content, target)
      if (correct && !cname.proxied) {
        // Already right. Doing nothing is what makes a resumed job cheap.
      } else if (!correct && !options.overwriteCname) {
        return {
          status: 'conflict',
          job,
          conflict: {
            kind: 'stale_cname',
            recordType: 'CNAME',
            value: cname.content,
            safeToOverwrite: true,
          },
        }
      } else {
        // Delete then create, rather than update: the provider interface has no
        // update, and a record recreated here is guaranteed to carry this
        // panel's own settings — DNS-only above all — instead of inheriting
        // whatever the old one had.
        await deps.dns.deleteRecord(zoneId, cname.id)
        await deps.dns.createRecord(zoneId, { type: 'CNAME', name: host, content: target })
      }
    } else {
      await deps.dns.createRecord(zoneId, { type: 'CNAME', name: host, content: target })
    }

    // The ownership TXT is not optional and not conditional on anything the
    // operator chooses. Without it the certificate sits in VALIDATING_OWNERSHIP
    // indefinitely and no screen anywhere explains why — this repository has
    // lost hours to precisely that, more than once.
    const verification = job.verification
    if (verification) {
      const existingTxt = await deps.dns.findRecords(zoneId, verification.name)
      const present = existingTxt.some(
        (record) => record.type === 'TXT' && unquote(record.content) === verification.content
      )
      if (!present) {
        await deps.dns.createRecord(zoneId, {
          type: 'TXT',
          name: verification.name,
          content: verification.content,
        })
      }
    }
  } catch (error) {
    const detail = describe(error)
    return { status: 'failed', job: await fail(job, detail), error: detail }
  }

  return { status: 'advanced', job: await save(job, { steps: { ...job.steps, dns: 'ok' } }) }
}

async function probeHost(host: string): Promise<boolean> {
  const path = process.env.LINKYARD_HEALTH_PATH ?? '/healthz'
  try {
    const response = await fetch(`https://${host}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

async function stepCertificate(job: ProvisionJob, deps: AdvanceDeps): Promise<AdvanceResult> {
  let certificate: CertStatus
  try {
    certificate = (await deps.infra.hostStatus(job.input.host)).certificate
  } catch (error) {
    const detail = describe(error)
    return { status: 'failed', job: await fail(job, detail), error: detail }
  }

  if (certificate === 'failed') {
    const detail = 'the certificate could not be issued'
    return { status: 'failed', job: await fail(job, detail), error: detail }
  }
  if (certificate !== 'valid') {
    return { status: 'waiting', job: await save(job, { certificate }), reason: 'certificate' }
  }

  // The provider says the certificate is valid. That is not the same as the
  // host answering, and the difference is minutes of DNS propagation during
  // which a panel claiming success is simply lying. So the host is asked.
  const probe = deps.probe ?? probeHost
  if (!(await probe(job.input.host))) {
    return { status: 'waiting', job: await save(job, { certificate }), reason: 'propagating' }
  }

  return {
    status: 'advanced',
    job: await save(job, { certificate, steps: { ...job.steps, certificate: 'ok' } }),
  }
}

async function stepRecord(job: ProvisionJob): Promise<AdvanceResult> {
  const { zoneId, zoneName, host, credentialId } = job.input
  const target = job.cnameTarget

  const ids = await transaction(async (client) => {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM domains WHERE lower(apex) = lower($1)`,
      [zoneName]
    )
    let domainId = found.rows[0]?.id
    if (domainId) {
      // An apex that was already here keeps its settings; only the facts this
      // job established are filled in, and only where they were missing.
      await client.query(
        `UPDATE domains
            SET dns_zone_id = COALESCE(dns_zone_id, $2),
                dns_credential_id = COALESCE(dns_credential_id, $3::uuid),
                verified_at = COALESCE(verified_at, now())
          WHERE id = $1`,
        [domainId, zoneId, credentialId]
      )
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO domains (apex, dns_zone_id, dns_credential_id, verified_at)
         VALUES ($1, $2, $3::uuid, now())
         RETURNING id`,
        [zoneName, zoneId, credentialId]
      )
      domainId = created.rows[0].id
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM subdomains WHERE lower(host) = lower($1)`,
      [host]
    )
    const values = [domainId, host, job.hostId, target, 'valid', 'ok'] as const

    if (existing.rows[0]) {
      await client.query(
        `UPDATE subdomains
            SET domain_id = $1, infra_host_id = $3, record_type = 'CNAME', record_value = $4,
                cert_status = $5, health = $6, last_checked_at = now(), active = true
          WHERE id = $7`,
        [...values, existing.rows[0].id]
      )
      return { domainId, subdomainId: existing.rows[0].id }
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO subdomains
         (domain_id, host, infra_host_id, record_type, record_value, cert_status, health, last_checked_at)
       VALUES ($1, $2, $3, 'CNAME', $4, $5, $6, now())
       RETURNING id`,
      [...values]
    )
    return { domainId, subdomainId: inserted.rows[0].id }
  })

  const next = await save(job, {
    state: 'done',
    steps: { ...job.steps, record: 'ok' },
    domainId: ids.domainId,
    subdomainId: ids.subdomainId,
  })
  return { status: 'done', job: next }
}

// ---------------------------------------------------------------- credentials

export type CredentialSummary = {
  id: string
  label: string
  last4: string
  scopes: TokenScope | null
  verifiedAt: Date | null
}

export type ConnectResult =
  | { ok: true; credential: CredentialSummary; scope: TokenScope }
  | { ok: false; code: 'rejected' | 'duplicate_label' | 'no_key'; detail: string }

function vaultKey(): Buffer | null {
  const master = process.env.ENCRYPTION_KEY
  if (!master || master.length < 32) return null
  return deriveKey(master)
}

/**
 * Verify a Cloudflare token and store it sealed.
 *
 * The scope is not judged here. What a token is allowed to touch only becomes a
 * yes or a no once there is a specific zone to compare it against, and that
 * happens at startProvision. What is recorded here is what was found, so the
 * screen can show it without decrypting anything.
 */
export async function connectDnsCredential(params: {
  label: string
  token: Secret
  userId: string | null
}): Promise<ConnectResult> {
  const key = vaultKey()
  if (!key) return { ok: false, code: 'no_key', detail: 'ENCRYPTION_KEY is not set' }

  const provider = new CloudflareDns(params.token)
  let scope: TokenScope
  try {
    const identity = await provider.verifyToken()
    if (identity.status !== 'active') {
      return { ok: false, code: 'rejected', detail: `the token is ${identity.status}` }
    }
    scope = await provider.tokenScope()
  } catch (error) {
    return { ok: false, code: 'rejected', detail: describe(error) }
  }

  const label = params.label.trim() || 'Cloudflare'
  const duplicate = await queryOne<{ id: string }>(
    `SELECT id FROM credentials WHERE provider = 'cloudflare' AND lower(label) = lower($1)`,
    [label]
  )
  if (duplicate) return { ok: false, code: 'duplicate_label', detail: label }

  const row = await queryOne<{ id: string; label: string; last4: string; verified_at: Date }>(
    `INSERT INTO credentials (provider, label, ciphertext, last4, scopes, verified_at, created_by)
     VALUES ('cloudflare', $1, $2, $3, $4::jsonb, now(), $5::uuid)
     RETURNING id, label, last4, verified_at`,
    [label, seal(key, params.token), last4(params.token), JSON.stringify(scope), params.userId]
  )
  if (!row) return { ok: false, code: 'rejected', detail: 'the credential could not be stored' }

  return {
    ok: true,
    scope,
    credential: {
      id: row.id,
      label: row.label,
      last4: row.last4,
      scopes: scope,
      verifiedAt: row.verified_at,
    },
  }
}

export async function listDnsCredentials(): Promise<CredentialSummary[]> {
  const rows = await query<{
    id: string
    label: string
    last4: string
    scopes: TokenScope | null
    verified_at: Date | null
  }>(
    `SELECT id, label, last4, scopes, verified_at
       FROM credentials
      WHERE provider = 'cloudflare'
      ORDER BY lower(label)`
  )
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    last4: row.last4,
    scopes: row.scopes,
    verifiedAt: row.verified_at,
  }))
}

/**
 * The infrastructure provider this installation runs on, or null.
 *
 * Null is a real answer, not a failure: a VPS install serves every host off one
 * wildcard certificate and has nothing to register. Until that adapter exists,
 * the screen that needs this says so plainly rather than offering a button that
 * cannot work.
 */
export function resolveInfraProvider(): InfraProvider | null {
  const token = process.env.RAILWAY_API_TOKEN?.trim()
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim()
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim()
  const serviceId = process.env.RAILWAY_EDGE_SERVICE_ID?.trim()
  if (!token || !projectId || !environmentId || !serviceId) return null

  const port = Number(process.env.RAILWAY_EDGE_PORT)
  return new RailwayInfra({
    token: new Secret(token),
    projectId,
    environmentId,
    serviceId,
    targetPort: Number.isFinite(port) && port > 0 ? port : undefined,
  })
}

export async function loadDnsCredential(
  credentialId: string
): Promise<{ id: string; label: string; provider: CloudflareDns }> {
  const key = vaultKey()
  if (!key) throw new ProviderError('invalid_input', 'ENCRYPTION_KEY is not set')

  const row = await queryOne<{ id: string; label: string; ciphertext: Buffer }>(
    `SELECT id, label, ciphertext FROM credentials WHERE id = $1::uuid AND provider = 'cloudflare'`,
    [credentialId]
  )
  if (!row) throw new ProviderError('not_found', 'no such credential')

  // open() returns a Secret, so the plaintext never exists as a bare string
  // anywhere between the database and the Authorization header.
  return { id: row.id, label: row.label, provider: new CloudflareDns(open(key, row.ciphertext)) }
}
