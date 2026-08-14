import test from 'node:test'
import assert from 'node:assert/strict'
import { FAILURE, ProvisionError, Secret } from '../src/secret.mjs'
import { assertCreatableHost } from '../src/cloudflare.mjs'
import {
  COST,
  PHASES,
  buildPlan,
  createAdmin,
  createJobStore,
  jobView,
  notifyOperator,
  orderServices,
  plannedRecords,
  runJob,
  startJob,
  validateInput,
} from '../src/provision.mjs'

const RAILWAY_SENTINEL = 'rw-sentinel-1c3f-never-printed-ee54'
const CLOUDFLARE_SENTINEL = 'cf-sentinel-never-printed'
const PASSWORD_SENTINEL = 'pw-sentinel-never-printed'

const TEMPLATE = {
  $comment: ['stripped'],
  services: [
    {
      name: 'postgres',
      source: { image: 'postgres:18-alpine' },
      volume: { mountPath: '/var/lib/postgresql/data', $comment: 'stripped' },
      variables: { POSTGRES_USER: 'linkyard', PGDATA: '/var/lib/postgresql/data/pgdata' },
      healthcheckPath: null,
    },
    {
      name: 'edge',
      source: { repo: 'https://github.com/paulotfchaves/linkyard', rootDirectory: '/', dockerfilePath: 'edge/Dockerfile' },
      variables: { DATABASE_URL: '${{postgres.RAILWAY_PRIVATE_DOMAIN}}', ENCRYPTION_KEY: '${{panel.ENCRYPTION_KEY}}' },
      healthcheckPath: '/healthz',
      restartPolicyType: 'ON_FAILURE',
    },
    {
      name: 'panel',
      source: { repo: 'https://github.com/paulotfchaves/linkyard', rootDirectory: '/', dockerfilePath: 'panel/Dockerfile' },
      variables: {
        DATABASE_URL: '${{postgres.RAILWAY_PRIVATE_DOMAIN}}',
        SETUP_TOKEN: '${{secret(64, "abcdef0123456789")}}',
        PANEL_ORIGIN: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
        $comment: 'stripped',
      },
      publicNetworking: { generateServiceDomain: true, targetPort: 3000 },
      restartPolicyType: 'ON_FAILURE',
    },
  ],
}

const INPUT = {
  email: 'owner@example.com',
  password: PASSWORD_SENTINEL,
  apex: 'example.com',
  panelHost: 'links',
  redirectHost: 'go',
  locale: 'en',
  timezone: 'America/Sao_Paulo',
}

function records(host) {
  return [
    { type: 'CNAME', name: host, value: `${host.split('.')[0]}.up.railway.app` },
    { type: 'TXT', name: `_railway-verify.${host}`, value: 'verify-token' },
  ]
}

/**
 * Doubles for both providers, plus a trace of what the browser had been told at
 * the moment of each call — that is what makes "streamed before the next call"
 * an assertion rather than a hope.
 */
function fakes({ failAt = null, failRollback = false } = {}) {
  const trace = []
  let job = null
  const witness = (name) => trace.push({ call: name, events: job ? job.events.length : 0 })
  const guard = (name) => {
    if (failAt === name) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
  }

  const railway = {
    async resolveAccount() {
      return { accountEmail: 'owner@example.com', accountName: 'Owner', workspaceId: 'w1', workspaceName: 'Personal', workspaceCount: 1 }
    },
    async createProject() {
      witness('createProject')
      guard('createProject')
      return { projectId: 'p1', environmentId: 'e1', name: 'linkyard-example-com' }
    },
    async createService(token, { name }) {
      witness(`createService:${name}`)
      guard(`createService:${name}`)
      return { serviceId: `svc-${name}`, name }
    },
    async createVolume() {
      witness('createVolume')
      return { volumeId: 'v1' }
    },
    async updateServiceInstance() {},
    async createServiceDomain() {
      witness('createServiceDomain')
      return 'panel-production.up.railway.app'
    },
    async deployService() {},
    async waitForDeployment() {
      guard('waitForDeployment')
      return 'SUCCESS'
    },
    async createCustomDomain(token, { domain }) {
      witness(`createCustomDomain:${domain}`)
      guard('createCustomDomain')
      return { customDomainId: `cd-${domain}`, domain, records: records(domain) }
    },
    async customDomainStatus() {
      guard('customDomainStatus')
      return { certificateStatus: 'ISSUED', records: [] }
    },
    async deleteProject() {
      trace.push({ call: 'deleteProject' })
      if (failRollback) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
    },
    async destroyToken() {
      trace.push({ call: 'destroyToken' })
      return { deleted: true, confirmed: true, code: null }
    },
  }

  const cloudflare = {
    assertCreatableHost,
    async inspectCredential() {
      return { zoneId: 'z1', zoneName: 'example.com', expiresOn: '2026-08-15T00:00:00Z' }
    },
    async createRecord(token, zoneId, record) {
      witness(`createRecord:${record.name}`)
      guard(`createRecord:${record.name}`)
      return { id: `rec-${record.name}`, ...record }
    },
    async deleteRecord(token, zoneId, id) {
      trace.push({ call: `deleteRecord:${id}` })
      if (failRollback) throw new ProvisionError(FAILURE.CLOUDFLARE_API_FAILED)
    },
  }

  return {
    trace,
    bind(target) {
      job = target
    },
    deps: {
      railway,
      cloudflare,
      sleep: async () => {},
      resolveCname: async (host) => (host.startsWith('links.') ? ['panel-production.up.railway.app'] : []),
      randomToken: () => 'setup-token-from-the-installer',
      fetchImpl: async (url) => {
        trace.push({ call: `fetch:${new URL(url).pathname}` })
        if (String(url).endsWith('/setup')) {
          if (failAt === 'admin') return { status: 200, ok: true }
          return { status: 302, ok: false }
        }
        return { ok: true, status: 201, json: async () => ({ installs: 1 }) }
      },
      workerUrl: 'https://installs.example.dev',
      workerSecret: 'worker-secret',
    },
  }
}

function seedJob(store, extra = {}) {
  return store.create({
    input: validateInput(INPUT),
    railwayToken: new Secret(RAILWAY_SENTINEL),
    cloudflareToken: new Secret(CLOUDFLARE_SENTINEL),
    account: { workspaceId: 'w1', workspaceName: 'Personal', accountEmail: 'owner@example.com', workspaceCount: 1 },
    zone: { zoneId: 'z1', zoneName: 'example.com', expiresOn: '2026-08-15T00:00:00Z' },
    locale: 'en',
    ...extra,
  })
}

test('input is normalised, and a bare label becomes a host inside the apex', () => {
  const input = validateInput(INPUT)
  assert.equal(input.panelHost, 'links.example.com')
  assert.equal(input.redirectHost, 'go.example.com')
  assert.equal(input.username, 'owner')

  const already = validateInput({ ...INPUT, panelHost: 'links.example.com', redirectHost: '' })
  assert.equal(already.panelHost, 'links.example.com')
  assert.equal(already.redirectHost, null)
})

test('input that would point at the apex, at www, or at a foreign domain is refused', () => {
  const cases = [
    { ...INPUT, panelHost: 'www' },
    { ...INPUT, panelHost: 'example.com' },
    { ...INPUT, panelHost: 'links.other.com' },
    { ...INPUT, email: 'not-an-email' },
    { ...INPUT, password: 'short' },
    { ...INPUT, apex: 'nope' },
    { ...INPUT, locale: 'fr' },
    { ...INPUT, timezone: 'America/Sao Paulo; rm -rf' },
    { ...INPUT, redirectHost: 'links' },
  ]
  for (const candidate of cases) {
    assert.throws(
      () => validateInput(candidate),
      (error) => error.code === FAILURE.INPUT_INVALID || error.code === FAILURE.DNS_NAME_FORBIDDEN,
      `expected ${JSON.stringify(candidate)} to be refused`
    )
  }
})

test('services are ordered so a ${{other.VAR}} reference resolves', () => {
  const ordered = orderServices([
    { name: 'edge', variables: { KEY: '${{panel.ENCRYPTION_KEY}}', DB: '${{postgres.RAILWAY_PRIVATE_DOMAIN}}' } },
    { name: 'panel', variables: { DB: '${{postgres.RAILWAY_PRIVATE_DOMAIN}}' } },
    { name: 'postgres', variables: {} },
  ]).map((service) => service.name)

  assert.deepEqual(ordered, ['postgres', 'panel', 'edge'])
})

test('the plan overrides the setup token, because the installer has to know it', () => {
  const input = validateInput(INPUT)
  const plan = buildPlan(TEMPLATE, input, { setupToken: 'known-token' })
  const panel = plan.services.find((service) => service.name === 'panel')

  assert.equal(panel.variables.SETUP_TOKEN, 'known-token')
  assert.equal(panel.variables.PANEL_ORIGIN, 'https://links.example.com')
  assert.equal(panel.variables.$comment, undefined)
  assert.deepEqual(panel.source, { repo: 'paulotfchaves/linkyard' })
  assert.deepEqual(panel.settings, {
    rootDirectory: '/',
    dockerfilePath: 'panel/Dockerfile',
    restartPolicyType: 'ON_FAILURE',
  })

  const postgres = plan.services.find((service) => service.name === 'postgres')
  assert.deepEqual(postgres.volume, { mountPath: '/var/lib/postgresql/data' })
  assert.deepEqual(plan.targets.map((target) => target.host), ['links.example.com', 'go.example.com'])
})

test('the records shown before the confirmation cover both hosts', () => {
  assert.deepEqual(plannedRecords(validateInput(INPUT)).map((record) => `${record.type} ${record.name}`), [
    'CNAME links.example.com',
    'TXT _railway-verify.links.example.com',
    'CNAME go.example.com',
    'TXT _railway-verify.go.example.com',
  ])
})

test('a whole install runs its phases in order and hands back the panel URL', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes()
  world.bind(job)

  await runJob(job, TEMPLATE, world.deps)

  assert.equal(job.state, 'done')
  assert.deepEqual([...job.phases.values()], PHASES.map(() => 'done'))
  assert.deepEqual(job.result, { panelUrl: 'https://links.example.com', redirectUrl: 'https://go.example.com' })
  assert.deepEqual(job.tokenDeleted, { deleted: true, confirmed: true, code: null })
  assert.equal(world.trace.some((entry) => entry.call === 'fetch:/install'), true)
})

test('every resource reaches the browser before the call that follows it', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes()
  world.bind(job)

  await runJob(job, TEMPLATE, world.deps)

  // Each entry records how many events the browser could already see. The count
  // must be strictly increasing across creations: a call that happens while the
  // page still shows the previous total is a resource created before it was
  // announced.
  const creations = world.trace.filter((entry) => entry.call.startsWith('create'))
  for (let index = 1; index < creations.length; index += 1) {
    assert.ok(
      creations[index].events > creations[index - 1].events,
      `${creations[index].call} ran without announcing ${creations[index - 1].call}`
    )
  }
  assert.equal(job.inventory[0].kind, 'railway-project')
  assert.equal(job.events[0].kind, 'resource.railway-project')
})

test('the exact records are announced before a single one is written', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes()
  world.bind(job)

  await runJob(job, TEMPLATE, world.deps)

  const announcement = job.events.findIndex((event) => event.kind === 'dns.plan')
  const firstWrite = job.events.findIndex((event) => event.kind === 'resource.dns-record')
  assert.ok(announcement !== -1 && announcement < firstWrite)
  assert.match(job.events[announcement].label, /CNAME links\.example\.com/)
})

test('the certificate wait asks public DNS, never the visitor own host', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes()
  const asked = []
  world.deps.resolveCname = async (host) => {
    asked.push(host)
    return ['panel-production.up.railway.app']
  }
  world.bind(job)

  await runJob(job, TEMPLATE, world.deps)

  assert.deepEqual(asked, ['links.example.com', 'go.example.com'])
  assert.deepEqual(
    job.events.filter((event) => event.kind === 'dns.visible').map((event) => event.label),
    ['links.example.com', 'go.example.com']
  )
  // Nothing in the job ever fetched the host it just created.
  assert.equal(world.trace.some((entry) => entry.call.startsWith('fetch:') && entry.call !== 'fetch:/setup' && entry.call !== 'fetch:/install'), false)
})

test('a failure rolls back what this job created, in reverse', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes({ failAt: 'createRecord:_railway-verify.go.example.com' })
  world.bind(job)

  await runJob(job, TEMPLATE, world.deps)

  assert.equal(job.state, 'failed')
  assert.equal(job.failure.code, FAILURE.RAILWAY_API_FAILED)
  assert.equal(job.phases.get('dns'), 'failed')

  const rollback = world.trace.filter((entry) => entry.call.startsWith('deleteRecord') || entry.call === 'deleteProject')
  assert.deepEqual(rollback.map((entry) => entry.call), [
    'deleteRecord:rec-go.example.com',
    'deleteRecord:rec-_railway-verify.links.example.com',
    'deleteRecord:rec-links.example.com',
    'deleteProject',
  ])
  assert.deepEqual(job.manualCleanup, [])
})

test('a rollback that fails names every stranded resource instead of apologising', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes({ failAt: 'customDomainStatus', failRollback: true })
  world.bind(job)

  await runJob(job, TEMPLATE, world.deps)

  assert.equal(job.state, 'manual_cleanup_required')
  const labels = job.manualCleanup.map((entry) => entry.label)
  assert.ok(labels.includes('linkyard-example-com'))
  assert.ok(labels.includes('panel'))
  assert.ok(labels.includes('postgres'))
  assert.ok(labels.includes('links.example.com'))
  assert.ok(labels.some((label) => label.startsWith('CNAME links.example.com')))

  const view = jobView(job, (key) => key)
  assert.ok(view.manualCleanup.every((line) => line.startsWith('event.resource.')))
})

test('the token is destroyed on the failure path as well as the success path', async () => {
  for (const failAt of [null, 'createProject', 'waitForDeployment', 'createCustomDomain', 'admin']) {
    const store = createJobStore()
    const job = seedJob(store)
    const world = fakes({ failAt })
    world.bind(job)

    await runJob(job, TEMPLATE, world.deps)

    assert.equal(world.trace.filter((entry) => entry.call === 'destroyToken').length, 1, `failAt=${failAt}`)
    assert.equal(job.phases.get('cleanup'), 'done', `failAt=${failAt}`)
    // And the credential leaves the process whatever happened.
    assert.equal(job.railwayToken, null)
    assert.equal(job.cloudflareToken, null)
  }
})

test('no sentinel survives any failure branch, in stdout or in the view', async () => {
  const written = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk))
    return originalOut(chunk, ...rest)
  }
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk))
    return originalErr(chunk, ...rest)
  }

  try {
    const branches = [
      null,
      'createProject',
      'createService:postgres',
      'createService:panel',
      'waitForDeployment',
      'createCustomDomain',
      'createRecord:links.example.com',
      'customDomainStatus',
      'admin',
    ]

    for (const failAt of branches) {
      const store = createJobStore()
      const job = seedJob(store)
      const world = fakes({ failAt, failRollback: failAt === 'admin' })
      world.bind(job)

      await runJob(job, TEMPLATE, world.deps)

      const serialized = JSON.stringify(jobView(job, (key) => key))
      for (const sentinel of [RAILWAY_SENTINEL, CLOUDFLARE_SENTINEL, PASSWORD_SENTINEL]) {
        assert.equal(serialized.includes(sentinel), false, `${sentinel} reached the view (failAt=${failAt})`)
      }
    }
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }

  const output = written.join('')
  for (const sentinel of [RAILWAY_SENTINEL, CLOUDFLARE_SENTINEL, PASSWORD_SENTINEL]) {
    assert.equal(output.includes(sentinel), false, `${sentinel} was printed`)
  }
})

test('a job id without its cookie secret opens nothing', () => {
  const store = createJobStore()
  const job = seedJob(store)

  assert.equal(store.authorize(job.id, 'guessed'), null)
  assert.equal(store.authorize(job.id, ''), null)
  assert.equal(store.authorize('not-an-id', job.secret), null)
  assert.equal(store.authorize(job.id, job.secret), job)
})

test('the job view carries no credential, and localises what it shows', () => {
  const store = createJobStore()
  const job = seedJob(store)
  const view = jobView(job, (key) => `t:${key}`)

  assert.equal(JSON.stringify(view).includes(RAILWAY_SENTINEL), false)
  assert.equal(JSON.stringify(view).includes(PASSWORD_SENTINEL), false)
  assert.deepEqual(view.phases.map((phase) => phase.label), PHASES.map((phase) => `t:phase.${phase}`))
  assert.deepEqual(view.cost, COST)
  assert.equal(view.account.workspace, 'Personal')
})

test('the concurrency ceiling refuses a fourth job rather than dying under it', () => {
  const store = createJobStore({ maxConcurrent: 2 })
  seedJob(store)
  seedJob(store)

  assert.throws(
    () => seedJob(store),
    (error) => error.code === FAILURE.TOO_MANY_JOBS
  )

  assert.equal(store.active(), 2)
})

test('a job removed after a failed verification frees its slot immediately', () => {
  const store = createJobStore({ maxConcurrent: 1 })
  const job = seedJob(store)
  store.remove(job.id)
  assert.doesNotThrow(() => seedJob(store))
})

test('SIGTERM waits for an in-flight rollback instead of abandoning it', async () => {
  const store = createJobStore()
  const job = seedJob(store)
  const world = fakes({ failAt: 'createRecord:links.example.com' })
  world.bind(job)

  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  world.deps.railway.deleteProject = async () => {
    world.trace.push({ call: 'deleteProject' })
    await gate
  }

  startJob(job, TEMPLATE, world.deps)
  await new Promise((resolve) => setImmediate(resolve))

  let drained = false
  const draining = store.drain(5000).then(() => {
    drained = true
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(drained, false, 'drain returned while a rollback was still running')
  // And no new work is accepted while draining.
  assert.throws(
    () => seedJob(store),
    (error) => error.code === FAILURE.TOO_MANY_JOBS
  )

  release()
  await draining
  assert.equal(job.state, 'failed')
  assert.equal(world.trace.some((entry) => entry.call === 'destroyToken'), true)
})

test('the owner account is created inside the job, and the password never travels in a URL', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return { status: 302, ok: false }
  }

  await createAdmin('https://links.example.com', 'setup-token', validateInput(INPUT), { fetchImpl })

  assert.equal(seen[0].url, 'https://links.example.com/setup')
  assert.equal(seen[0].url.includes(PASSWORD_SENTINEL), false)
  assert.equal(seen[0].init.redirect, 'manual')
  assert.match(seen[0].init.body, /token=setup-token/)

  await assert.rejects(
    () => createAdmin('https://links.example.com', 'setup-token', validateInput(INPUT), { fetchImpl: async () => ({ status: 200 }) }),
    (error) => error.code === FAILURE.ADMIN_CREATE_FAILED
  )
})

test('the operator is told an address and a locale, and nothing else', async () => {
  const seen = []
  const job = { input: validateInput(INPUT) }
  const sent = await notifyOperator(job, {
    workerUrl: 'https://installs.example.dev/',
    workerSecret: 'worker-secret',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return { ok: true }
    },
  })

  assert.equal(sent, true)
  assert.equal(seen[0].url, 'https://installs.example.dev/install')
  assert.deepEqual(JSON.parse(seen[0].init.body), { email: 'owner@example.com', locale: 'en' })
  assert.equal(seen[0].init.headers['x-install-secret'], 'worker-secret')

  // Unconfigured is silence, not a failure: the visitor's install does not
  // depend on the operator's bookkeeping.
  assert.equal(await notifyOperator(job, { workerUrl: null, workerSecret: null }), false)
})
