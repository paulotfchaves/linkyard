// The provisioning job: what it creates, in what order, and what it undoes.
//
// Three properties shape this file more than the happy path does.
//
// Nothing is created before the browser knows about it. Every resource is
// appended to an inventory and streamed to the page *before* the next API call,
// so a job killed by a redeploy still leaves the visitor holding a list of what
// exists in their account. A provisioner that batches its reporting bills people
// for services nobody can name.
//
// The undo runs while the credential is still alive. Rollback happens before the
// token is destroyed, in that order and never the reverse — a rollback that
// starts after cleanup has no way to delete anything.
//
// The token dies either way. `cleanup` sits in a finally: success, failure and
// rollback failure all end with `apiTokenDelete`, because a burned token is a
// burned token.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { resolveCname } from 'node:dns/promises'
import * as railwayApi from './railway.mjs'
import * as cloudflareApi from './cloudflare.mjs'
import { FAILURE, ProvisionError, asProvisionError } from './secret.mjs'

export const PHASES = Object.freeze(['verify', 'infra', 'domain', 'dns', 'certificate', 'admin', 'cleanup'])

// Stated before the button, never after the invoice (spec §10.7).
export const COST = Object.freeze({ minUsd: 5.5, maxUsd: 7, hobbyPlanUsd: 5 })

const LOCALES = new Set(['en', 'pt-BR'])
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,20}$/
const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/
const MIN_PASSWORD = 12

function fail(field) {
  return new ProvisionError(FAILURE.INPUT_INVALID, { field })
}

/**
 * A subdomain may be typed as a bare label ("panel") or in full
 * ("panel.example.com").
 *
 * The dot decides which it is. Appending the apex to anything that is not a bare
 * label is how "example.com" becomes "example.com.example.com" and
 * "links.other.com" becomes a host inside a domain the visitor never named —
 * both of which would sail past a guard that only looks at the final string.
 */
function resolveHost(value, apex, field) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
  if (raw === '') throw fail(field)

  const host = raw.includes('.') ? raw : `${raw}.${apex}`
  if (!HOSTNAME.test(host)) throw fail(field)

  const normalized = cloudflareApi.assertCreatableHost(apex, host)
  if (!LABEL.test(normalized.slice(0, normalized.length - apex.length - 1).split('.')[0])) throw fail(field)
  return normalized
}

export function validateInput(raw = {}) {
  const email = String(raw.email ?? '').trim().toLowerCase()
  if (!EMAIL.test(email)) throw fail('email')

  const password = String(raw.password ?? '')
  if (password.length < MIN_PASSWORD || password.length > 200) throw fail('password')

  const apex = String(raw.apex ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
  if (!HOSTNAME.test(apex)) throw fail('apex')

  const panelHost = resolveHost(raw.panelHost, apex, 'panelHost')
  const redirectHost = raw.redirectHost === undefined || String(raw.redirectHost).trim() === ''
    ? null
    : resolveHost(raw.redirectHost, apex, 'redirectHost')
  if (redirectHost && redirectHost === panelHost) throw fail('redirectHost')

  const locale = String(raw.locale ?? 'en')
  if (!LOCALES.has(locale)) throw fail('locale')

  const timezone = String(raw.timezone ?? 'UTC').trim()
  if (!TIMEZONE.test(timezone)) throw fail('timezone')

  // The panel wants a username; deriving it from the address keeps one field off
  // a form that already asks for nine.
  const username = (email.split('@')[0].replace(/[^a-z0-9._-]/g, '') || 'owner').slice(0, 32)

  return { email, password, apex, panelHost, redirectHost, locale, timezone, username }
}

function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('$'))
        .map(([key, entry]) => [key, stripComments(entry)])
    )
  }
  return value
}

function repoSlug(url) {
  const match = /github\.com\/([^/]+\/[^/.]+)/.exec(String(url ?? ''))
  return match ? match[1] : null
}

/**
 * Orders services so a `${{other.VAR}}` reference resolves.
 *
 * The edge borrows the panel's encryption key and both borrow the database URL.
 * Railway resolves those by service name at deploy time, so a service created
 * before the one it references starts its first build with an unresolved
 * variable — a failed deploy that looks like a code bug.
 */
export function orderServices(services) {
  const byName = new Map(services.map((service) => [service.name, service]))
  const ordered = []
  const seen = new Set()

  const visit = (service, stack = new Set()) => {
    if (seen.has(service.name) || stack.has(service.name)) return
    stack.add(service.name)
    for (const value of Object.values(service.variables ?? {})) {
      for (const [, name] of String(value).matchAll(/\$\{\{\s*([A-Za-z0-9_-]+)\./g)) {
        const dependency = byName.get(name)
        if (dependency) visit(dependency, stack)
      }
    }
    stack.delete(service.name)
    seen.add(service.name)
    ordered.push(service)
  }

  for (const service of services) visit(service)
  return ordered
}

/**
 * Turns the declared topology into the calls that build it.
 *
 * `railway-template.json` is the single declaration of what a Linkyard install
 * is; reading it here is what keeps the hosted installer, the CLI and a human in
 * Railway's composer building the same three services.
 *
 * One value is deliberately overridden. The template lets Railway mint
 * `SETUP_TOKEN` with `${{secret(64)}}`, which is right for a template and
 * useless here: the installer has to *know* that token to create the owner
 * account inside the job, and a setup route left open on a hostname already
 * published to Certificate Transparency is the failure §6.1 exists to prevent.
 */
// Matches the template's own secret() spelling, with or without arguments.
const SECRET_FN_RE = /\$\{\{\s*secret\s*\(/

export function buildPlan(template, input, generated) {
  const services = stripComments(template).services.map((service) => {
    const source = service.source?.image
      ? { image: service.source.image }
      : { repo: repoSlug(service.source?.repo) }

    const settings = {}
    if (service.source?.rootDirectory) settings.rootDirectory = service.source.rootDirectory
    if (service.source?.dockerfilePath) settings.dockerfilePath = service.source.dockerfilePath
    if (service.healthcheckPath) settings.healthcheckPath = service.healthcheckPath
    if (service.restartPolicyType) settings.restartPolicyType = service.restartPolicyType

    const variables = { ...(service.variables ?? {}) }
    if (service.name === 'panel') {
      variables.SETUP_TOKEN = generated.setupToken
      variables.PANEL_ORIGIN = `https://${input.panelHost}`
    }

    // Every remaining secret() has to be minted here, not passed through.
    //
    // `${{secret(64)}}` is a TEMPLATE variable function: Railway executes it
    // when a template is deployed. This installer does not deploy a template —
    // it calls projectCreate and serviceCreate directly — so the function never
    // runs and the literal string becomes the value.
    //
    // The consequence is not cosmetic. ENCRYPTION_KEY is the master key for the
    // vault that seals every Cloudflare token an installation's users store, and
    // deriveKey accepts that 35-character literal without complaint. Left as-is,
    // every install created through this page would encrypt its users'
    // credentials with a key derived from a string published in the public repo.
    // IP_HASH_SALT identical everywhere would make click hashes correlatable
    // across installs, and POSTGRES_PASSWORD would be a public constant.
    //
    // Reference variables like ${{postgres.POSTGRES_PASSWORD}} DO resolve on
    // this path, so only secret() is substituted.
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'string' && SECRET_FN_RE.test(value)) {
        variables[key] = generated.mint(`${service.name}.${key}`)
      }
    }

    return {
      name: service.name,
      source,
      settings,
      variables,
      volume: service.volume?.mountPath ? { mountPath: service.volume.mountPath } : null,
      targetPort: service.publicNetworking?.targetPort ?? null,
      generateServiceDomain: service.publicNetworking?.generateServiceDomain === true,
    }
  })

  const targets = [{ role: 'panel', host: input.panelHost, service: 'panel', targetPort: 3000 }]
  if (input.redirectHost) targets.push({ role: 'redirect', host: input.redirectHost, service: 'edge', targetPort: 3100 })

  return {
    projectName: `linkyard-${input.apex.replace(/[^a-z0-9]+/g, '-')}`.slice(0, 40),
    services: orderServices(services),
    targets,
  }
}

/** The records the visitor is shown before anything is written (control 4). */
export function plannedRecords(input) {
  const hosts = [input.panelHost, input.redirectHost].filter(Boolean)
  return hosts.flatMap((host) => [
    { type: 'CNAME', name: host, value: 'pending' },
    { type: 'TXT', name: `_railway-verify.${host}`, value: 'pending' },
  ])
}

// ── the job ────────────────────────────────────────────────────────────────

function newJob({ input, railwayToken, cloudflareToken, account, zone, locale, clock }) {
  return {
    id: randomUUID(),
    // The cookie half of control 7. The id alone opens nothing: it travels in
    // URLs and logs, and whoever held it would otherwise read back the panel
    // address of somebody else's brand-new installation.
    secret: randomBytes(32).toString('hex'),
    createdAt: clock(),
    state: 'awaiting_confirmation',
    locale,
    input,
    railwayToken,
    cloudflareToken,
    account,
    zone,
    phases: new Map(PHASES.map((phase) => [phase, phase === 'verify' ? 'done' : 'pending'])),
    events: [],
    inventory: [],
    plannedRecords: plannedRecords(input),
    result: null,
    failure: null,
    manualCleanup: [],
    tokenDeleted: null,
    running: null,
  }
}

export function createJobStore({
  maxConcurrent = 3,
  ttlMs = 30 * 60 * 1000,
  // A job waiting for a click is not a job doing work. Holding it for the same
  // half hour as a running provision meant a handful of abandoned tabs filled
  // the ceiling and kept two live credentials in memory the whole time.
  pendingTtlMs = 5 * 60 * 1000,
  clock = () => Date.now(),
  // Best-effort destruction for a job that is dropped before it ever runs.
  // The page promises the token is deleted "whether it succeeds or fails", and
  // the most common way to leave is closing the tab at the confirm screen —
  // which is exactly the path that never reached runJob's finally.
  destroyToken = null,
} = {}) {
  const jobs = new Map()
  let draining = false

  // Forgetting a job must also forget what it was holding. Two Secrets sitting
  // in a dropped map entry are two live credentials waiting for a heap dump.
  function release(job, { destroy = true } = {}) {
    const token = job?.credentials?.railway ?? null
    if (job?.credentials) {
      job.credentials.railway = null
      job.credentials.cloudflare = null
    }
    if (destroy && token && destroyToken && !job.tokenDestroyed) {
      job.tokenDestroyed = true
      Promise.resolve()
        .then(() => destroyToken(token))
        .catch(() => {})
    }
  }

  function sweep() {
    for (const [id, job] of jobs) {
      const pending = job.state === 'awaiting_confirmation'
      const finished = job.state !== 'running' && !pending
      const age = clock() - job.createdAt
      if ((pending && age > pendingTtlMs) || (finished && age > ttlMs)) {
        release(job)
        jobs.delete(id)
      }
    }
  }

  function occupied() {
    return [...jobs.values()].filter((job) => job.state === 'running' || job.state === 'awaiting_confirmation').length
  }

  return {
    create(seed) {
      sweep()
      if (draining) throw new ProvisionError(FAILURE.TOO_MANY_JOBS)
      // Control 8. Not an anti-abuse measure — whoever holds a stolen token can
      // call the same APIs with curl. It is what keeps the operator's single
      // process from dying under a handful of concurrent provisions.
      if (occupied() >= maxConcurrent) throw new ProvisionError(FAILURE.TOO_MANY_JOBS)
      const job = newJob({ ...seed, clock })
      jobs.set(job.id, job)
      return job
    },

    authorize(id, secret) {
      const job = jobs.get(String(id ?? ''))
      if (!job) return null
      const given = Buffer.from(String(secret ?? ''))
      const expected = Buffer.from(job.secret)
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      return job
    },

    get(id) {
      return jobs.get(id) ?? null
    },

    // A job whose credentials never checked out frees its slot immediately.
    // Leaving it to the sweep would let a handful of typos hold the ceiling for
    // half an hour.
    remove(id) {
      const job = jobs.get(String(id ?? ''))
      if (job) release(job)
      jobs.delete(id)
    },

    size() {
      return jobs.size
    },

    active() {
      return occupied()
    },

    /**
     * SIGTERM arrives mid-job on every redeploy. Exiting immediately abandons a
     * half-built project in somebody's account with the token already gone, so
     * the process refuses new work and waits for the in-flight rollbacks and
     * token deletions to finish.
     */
    async drain(timeoutMs = 20_000) {
      draining = true
      const inFlight = [...jobs.values()].map((job) => job.running).filter(Boolean)
      if (inFlight.length === 0) return { drained: 0, timedOut: false }
      let timedOut = false
      let timer
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
      })
      await Promise.race([Promise.allSettled(inFlight), deadline])
      clearTimeout(timer)
      return { drained: inFlight.length, timedOut }
    },
  }
}

function emit(job, kind, label = null) {
  job.events.push({ at: Date.now(), kind, label })
}

function record(job, entry) {
  job.inventory.push(entry)
  // Streamed before the next call, which is the point of the inventory.
  emit(job, `resource.${entry.kind}`, entry.label)
}

/**
 * Verifies both credentials and resolves what they point at (control 6).
 *
 * Nothing is created here. The visitor sees which Railway account and which
 * Cloudflare zone answered, plus the monthly cost, and the job waits for a
 * click — because the common mistake is pasting the token of the wrong account,
 * and the only cheap moment to catch it is before the first billed resource.
 */
export async function verifyCredentials({ railwayToken, cloudflareToken, input }, deps = {}) {
  const railway = deps.railway ?? railwayApi
  const cloudflare = deps.cloudflare ?? cloudflareApi

  const account = await railway.resolveAccount(railwayToken, deps)
  const zone = await cloudflare.inspectCredential(cloudflareToken, input.apex, deps)
  return { account, zone }
}

async function runInfra(job, plan, deps) {
  const railway = deps.railway ?? railwayApi
  const token = job.railwayToken

  const project = await railway.createProject(
    token,
    { workspaceId: job.account.workspaceId, name: plan.projectName },
    deps
  )
  record(job, { kind: 'railway-project', id: project.projectId, label: plan.projectName })
  job.project = project

  for (const service of plan.services) {
    const created = await railway.createService(
      token,
      {
        projectId: project.projectId,
        environmentId: project.environmentId,
        name: service.name,
        source: service.source,
        variables: service.variables,
      },
      deps
    )
    record(job, { kind: 'railway-service', id: created.serviceId, label: service.name })
    service.id = created.serviceId

    if (service.volume) {
      await railway.createVolume(
        token,
        {
          projectId: project.projectId,
          environmentId: project.environmentId,
          serviceId: created.serviceId,
          mountPath: service.volume.mountPath,
        },
        deps
      )
      record(job, { kind: 'railway-volume', id: created.serviceId, label: `${service.name}:${service.volume.mountPath}` })
    }

    await railway.updateServiceInstance(
      token,
      { serviceId: created.serviceId, environmentId: project.environmentId, settings: service.settings },
      deps
    )

    if (service.generateServiceDomain && service.targetPort) {
      // Before the custom domain, never after: a custom domain added to a
      // service with no service domain and no target port answers "Application
      // not found" at the edge, and the certificate never leaves VALIDATING.
      const domain = await railway.createServiceDomain(
        token,
        { environmentId: project.environmentId, serviceId: created.serviceId, targetPort: service.targetPort },
        deps
      )
      record(job, { kind: 'railway-service-domain', id: created.serviceId, label: domain })
    }
  }

  for (const service of plan.services) {
    if (!service.source.repo) continue
    await railway.deployService(token, { serviceId: service.id, environmentId: project.environmentId }, deps)
  }

  const panel = plan.services.find((service) => service.name === 'panel')
  await railway.waitForDeployment(
    token,
    { projectId: project.projectId, environmentId: project.environmentId, serviceId: panel.id },
    deps
  )
}

async function runDomain(job, plan, deps) {
  const railway = deps.railway ?? railwayApi
  const wanted = []

  for (const target of plan.targets) {
    const service = plan.services.find((candidate) => candidate.name === target.service)
    const created = await railway.createCustomDomain(
      job.railwayToken,
      {
        projectId: job.project.projectId,
        environmentId: job.project.environmentId,
        serviceId: service.id,
        domain: target.host,
        targetPort: target.targetPort,
      },
      deps
    )
    record(job, { kind: 'railway-custom-domain', id: created.customDomainId, label: target.host })
    target.customDomainId = created.customDomainId
    wanted.push(...created.records)
  }

  job.plannedRecords = wanted
}

async function runDns(job, deps) {
  const cloudflare = deps.cloudflare ?? cloudflareApi

  // Shown before written, every time (control 4).
  emit(job, 'dns.plan', job.plannedRecords.map((entry) => `${entry.type} ${entry.name}`).join(', '))

  for (const entry of job.plannedRecords) {
    cloudflare.assertCreatableHost(job.input.apex, entry.name.replace(/^_railway-verify\./, ''))
    const created = await cloudflare.createRecord(job.cloudflareToken, job.zone.zoneId, entry, deps)
    record(job, {
      kind: 'dns-record',
      id: created.id,
      zoneId: job.zone.zoneId,
      label: `${entry.type} ${entry.name}`,
    })
  }
}

async function runCertificate(job, plan, deps) {
  const railway = deps.railway ?? railwayApi
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const lookup = deps.resolveCname ?? resolveCname
  const tries = deps.certificateTries ?? 60
  const waitMs = deps.certificateWaitMs ?? 10_000

  for (const target of plan.targets) {
    let issued = false
    let visible = false
    for (let attempt = 0; attempt < tries && !issued; attempt += 1) {
      // A public resolver, never the visitor's host. The distinction the visitor
      // needs while staring at a spinner is "the record is not visible yet"
      // versus "it is visible and the certificate is the slow part", and asking
      // DNS is the only way to tell them apart from here.
      if (!visible) {
        try {
          const answers = await lookup(target.host)
          if (answers?.length > 0) {
            visible = true
            emit(job, 'dns.visible', target.host)
          }
        } catch {
          // Not yet propagated. The certificate poll is the one that decides.
        }
      }

      const status = await railway.customDomainStatus(job.railwayToken, target.customDomainId, deps)
      // Railway has used more than one spelling for a healthy certificate; the
      // installer treats any of them as issued rather than waiting out the clock
      // on a domain that is already serving.
      issued = ['ISSUED', 'VALID', 'ACTIVE'].includes(status.certificateStatus)
      if (!issued) await sleep(waitMs)
    }
    if (!issued) throw new ProvisionError(FAILURE.CERTIFICATE_TIMEOUT, { host: target.host })
    emit(job, 'certificate.issued', target.host)
  }
}

/**
 * Creates the owner account inside the job.
 *
 * This is the one call the installer makes to the visitor's own host, and it is
 * the reason the form asks for a password. The alternative — handing back "a
 * link to create your account" — leaves an open setup route on a hostname whose
 * certificate reached the public Certificate Transparency stream seconds after
 * issuance, where scanners are already looking for exactly that.
 */
export async function createAdmin(panelUrl, setupToken, account, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const body = new URLSearchParams({
    token: setupToken,
    username: account.username,
    email: account.email,
    password: account.password,
    timezone: account.timezone,
    locale: account.locale,
  })

  let response
  try {
    response = await fetchImpl(`${panelUrl}/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch {
    throw new ProvisionError(FAILURE.ADMIN_CREATE_FAILED)
  }

  // The panel answers a successful claim with a redirect to /links. A 200 is the
  // form re-rendering with a validation problem, and a 404 is a setup route that
  // is already closed — both are failures, neither is quoted back.
  if (response.status !== 302 && response.status !== 303) throw new ProvisionError(FAILURE.ADMIN_CREATE_FAILED)
}

async function rollback(job, deps) {
  const railway = deps.railway ?? railwayApi
  const cloudflare = deps.cloudflare ?? cloudflareApi
  const stranded = []

  // Reverse order: the DNS records first, while the Cloudflare token is still in
  // memory, then the project, which takes its services, volumes and custom
  // domains with it.
  for (const entry of [...job.inventory].reverse()) {
    try {
      if (entry.kind === 'dns-record') {
        await cloudflare.deleteRecord(job.cloudflareToken, entry.zoneId, entry.id, deps)
      } else if (entry.kind === 'railway-project') {
        await railway.deleteProject(job.railwayToken, entry.id, deps)
      }
    } catch {
      stranded.push({ kind: entry.kind, label: entry.label })
    }
  }

  // A failed project delete strands everything inside it, and the visitor cannot
  // remove what nobody named.
  if (stranded.some((entry) => entry.kind === 'railway-project')) {
    for (const entry of job.inventory) {
      if (entry.kind.startsWith('railway-') && entry.kind !== 'railway-project') {
        stranded.push({ kind: entry.kind, label: entry.label })
      }
    }
  }

  return stranded
}

async function cleanup(job, deps) {
  const railway = deps.railway ?? railwayApi
  job.phases.set('cleanup', 'running')
  try {
    job.tokenDeleted = await railway.destroyToken(job.railwayToken, deps)
  } catch {
    job.tokenDeleted = { deleted: false, confirmed: false, code: FAILURE.RAILWAY_API_FAILED }
  }
  job.phases.set('cleanup', job.tokenDeleted.deleted ? 'done' : 'failed')

  // The credential leaves the process whatever the API said. Holding it after
  // the job would only widen the window in which a crash dump could carry it.
  job.railwayToken = null
  job.cloudflareToken = null
}

/**
 * Best-effort note to the operator: an address and a date, nothing else.
 *
 * Never throws, and never runs before the install succeeded. The visitor's
 * installation does not depend on the operator's bookkeeping.
 */
export async function notifyOperator(job, deps = {}) {
  const url = deps.workerUrl ?? process.env.INSTALL_WORKER_URL
  const secret = deps.workerSecret ?? process.env.INSTALL_WORKER_SECRET
  if (!url || !secret) return false

  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-secret': secret },
      body: JSON.stringify({ email: job.input.email, locale: job.input.locale }),
    })
    return response.ok
  } catch {
    return false
  }
}

export function startJob(job, template, deps = {}) {
  if (job.state !== 'awaiting_confirmation') throw new ProvisionError(FAILURE.JOB_NOT_FOUND)
  job.state = 'running'
  job.running = runJob(job, template, deps).catch(() => {})
  return job.running
}

export async function runJob(job, template, deps = {}) {
  const random = deps.randomToken ?? (() => randomBytes(32).toString('hex'))
  // One value per name, so the same variable referenced twice in the template
  // resolves to the same secret while two different variables never collide.
  const minted = new Map()
  const generated = {
    setupToken: random(),
    mint(name) {
      if (!minted.has(name)) minted.set(name, random())
      return minted.get(name)
    },
  }
  const plan = buildPlan(template, job.input, generated)
  const steps = [
    ['infra', () => runInfra(job, plan, deps)],
    ['domain', () => runDomain(job, plan, deps)],
    ['dns', () => runDns(job, deps)],
    ['certificate', () => runCertificate(job, plan, deps)],
    ['admin', () => createAdmin(`https://${job.input.panelHost}`, generated.setupToken, job.input, deps)],
  ]

  try {
    for (const [phase, step] of steps) {
      job.phases.set(phase, 'running')
      await step()
      job.phases.set(phase, 'done')
    }

    job.state = 'done'
    job.result = {
      panelUrl: `https://${job.input.panelHost}`,
      redirectUrl: job.input.redirectHost ? `https://${job.input.redirectHost}` : null,
    }
  } catch (error) {
    const failure = asProvisionError(error)
    job.failure = failure
    for (const [phase, status] of job.phases) {
      if (status === 'running') job.phases.set(phase, 'failed')
    }

    const stranded = await rollback(job, deps)
    if (stranded.length > 0) {
      job.state = 'manual_cleanup_required'
      job.manualCleanup = stranded
    } else {
      job.state = 'failed'
    }
  } finally {
    await cleanup(job, deps)
  }

  if (job.state === 'done') await notifyOperator(job, deps)
  return job
}


/**
 * The only shape that reaches the browser.
 *
 * Built by hand rather than by stripping fields off the job: an allow-list
 * cannot leak a token that somebody adds to the job next month, and a deny-list
 * can.
 */
export function jobView(job, translate) {
  const t = translate ?? ((key) => key)
  return {
    state: job.state,
    phases: PHASES.map((phase) => ({ key: phase, label: t(`phase.${phase}`), status: job.phases.get(phase) })),
    events: job.events.map((event) => ({ at: event.at, text: event.label ? `${t(`event.${event.kind}`)} ${event.label}` : t(`event.${event.kind}`) })),
    account: {
      workspace: job.account?.workspaceName ?? null,
      email: job.account?.accountEmail ?? null,
      workspaceCount: job.account?.workspaceCount ?? 0,
    },
    zone: { name: job.zone?.zoneName ?? null, expiresOn: job.zone?.expiresOn ?? null },
    cost: COST,
    records: job.plannedRecords.map((entry) => ({ type: entry.type, name: entry.name, value: entry.value })),
    result: job.result,
    failure: job.failure ? { code: job.failure.code, message: t(`error.${job.failure.code}`) } : null,
    manualCleanup: job.manualCleanup.map((entry) => `${t(`event.resource.${entry.kind}`)} ${entry.label}`),
    tokenDeleted: job.tokenDeleted ? { deleted: job.tokenDeleted.deleted, confirmed: job.tokenDeleted.confirmed } : null,
  }
}
