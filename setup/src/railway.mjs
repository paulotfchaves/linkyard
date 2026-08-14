// The Railway side of a provision, and the destruction of the token that ran it.
//
// Every call takes a `Secret`. The value is revealed once, on the line that
// builds the Authorization header, and nothing derived from the response is ever
// re-thrown verbatim: a GraphQL error array is read to pick a failure code and
// then dropped. `railway-provision.mjs` in the reference implementation throws
// `JSON.stringify(body.errors)`, which is how a token ends up in a log.
//
// Operation names and shapes come from schema introspection against
// backboard.railway.com/graphql/v2 (spec §10.2). Responses are normalised
// defensively — a connection that grows an `edges/node` wrapper, or loses one,
// must not turn into a crash mid-provision with resources already billed.

import { FAILURE, ProvisionError } from './secret.mjs'

export const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2'

function classify(status, errors) {
  if (status === 401 || status === 403) return FAILURE.RAILWAY_TOKEN_INVALID
  if (status === 429) return FAILURE.RAILWAY_RATE_LIMITED
  if (Array.isArray(errors) && errors.length > 0) {
    // The message is read here and nowhere else. It picks a code; it is never
    // stored, returned, or logged.
    const text = errors.map((error) => String(error?.message ?? '')).join(' ')
    if (/not authori[sz]ed|unauthenticated|invalid token/i.test(text)) return FAILURE.RAILWAY_TOKEN_INVALID
    if (/rate limit/i.test(text)) return FAILURE.RAILWAY_RATE_LIMITED
    return FAILURE.RAILWAY_API_FAILED
  }
  return FAILURE.RAILWAY_API_FAILED
}

/**
 * @param {import('./secret.mjs').Secret} token
 * @param {{ fetchImpl?: typeof fetch, endpoint?: string }} [deps]
 */
export async function graphql(token, query, variables, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const endpoint = deps.endpoint ?? RAILWAY_ENDPOINT

  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        // The only reveal in this module.
        authorization: `Bearer ${token.reveal()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    // The thrown error is discarded rather than wrapped: undici attaches the
    // request — headers included — to the cause chain of a network failure.
    throw new ProvisionError(FAILURE.RAILWAY_UNREACHABLE)
  }

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (!response.ok || body?.errors) {
    throw new ProvisionError(classify(response.status, body?.errors))
  }
  if (!body?.data) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
  return body.data
}

// A GraphQL connection may arrive as a list or as edges/node depending on the
// field. Both shapes mean the same thing to every caller below.
function nodes(connection) {
  if (!connection) return []
  if (Array.isArray(connection)) return connection
  if (Array.isArray(connection.edges)) return connection.edges.map((edge) => edge?.node).filter(Boolean)
  return []
}

/** Resolves which Railway account the pasted token actually belongs to (control 6). */
export async function resolveAccount(token, deps = {}) {
  let data
  try {
    data = await graphql(token, 'query{me{id email name workspaces{id name}}}', {}, deps)
  } catch (error) {
    // A project token can reach the API but not `me`. Saying "invalid token"
    // there sends the user hunting for a typo in a token that is merely the
    // wrong kind.
    if (error?.code === FAILURE.RAILWAY_TOKEN_INVALID) throw new ProvisionError(FAILURE.RAILWAY_TOKEN_NOT_ACCOUNT)
    throw error
  }

  const workspaces = nodes(data?.me?.workspaces)
  if (workspaces.length === 0) throw new ProvisionError(FAILURE.RAILWAY_WORKSPACE_MISSING)

  return {
    accountEmail: typeof data?.me?.email === 'string' ? data.me.email : null,
    accountName: typeof data?.me?.name === 'string' ? data.me.name : null,
    workspaceId: workspaces[0].id,
    workspaceName: workspaces[0].name ?? null,
    workspaceCount: workspaces.length,
  }
}

export async function createProject(token, { workspaceId, name }, deps = {}) {
  const data = await graphql(
    token,
    'mutation($i:ProjectCreateInput!){projectCreate(input:$i){id name primaryEnvironmentId}}',
    { i: { name, workspaceId, defaultEnvironmentName: 'production' } },
    deps
  )
  const project = data?.projectCreate
  if (!project?.id || !project?.primaryEnvironmentId) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
  return { projectId: project.id, environmentId: project.primaryEnvironmentId, name: project.name ?? name }
}

export async function createService(token, { projectId, environmentId, name, source, variables }, deps = {}) {
  const data = await graphql(
    token,
    'mutation($i:ServiceCreateInput!){serviceCreate(input:$i){id name}}',
    { i: { projectId, environmentId, name, source, variables } },
    deps
  )
  const service = data?.serviceCreate
  if (!service?.id) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
  return { serviceId: service.id, name: service.name ?? name }
}

/**
 * Build settings that do not belong to `serviceCreate`.
 *
 * The repo is the service's source; the Dockerfile path, the root directory and
 * the healthcheck are properties of the *instance* in an environment, and
 * Railway splits them across two mutations accordingly.
 */
export async function updateServiceInstance(token, { serviceId, environmentId, settings }, deps = {}) {
  if (!settings || Object.keys(settings).length === 0) return
  await graphql(
    token,
    'mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}',
    { s: serviceId, e: environmentId, i: settings },
    deps
  )
}

export async function createVolume(token, { projectId, environmentId, serviceId, mountPath }, deps = {}) {
  const data = await graphql(
    token,
    'mutation($i:VolumeCreateInput!){volumeCreate(input:$i){id}}',
    { i: { projectId, environmentId, serviceId, mountPath } },
    deps
  )
  const id = data?.volumeCreate?.id
  if (!id) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
  return { volumeId: id }
}

export async function upsertVariables(token, { projectId, environmentId, serviceId, variables }, deps = {}) {
  // One batched mutation, not one call per variable: separate upserts each queue
  // a redeploy and trip Railway's deployment rate limit on a service with a
  // dozen variables.
  await graphql(
    token,
    'mutation($i:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$i)}',
    { i: { projectId, environmentId, serviceId, variables } },
    deps
  )
}

export async function createServiceDomain(token, { environmentId, serviceId, targetPort }, deps = {}) {
  const data = await graphql(
    token,
    'mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}',
    { i: { environmentId, serviceId, targetPort } },
    deps
  )
  const domain = data?.serviceDomainCreate?.domain
  if (!domain) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)
  return domain
}

function normalizeDnsRecords(status) {
  return nodes(status?.dnsRecords)
    .map((record) => {
      const label = record?.hostlabel ?? ''
      const zone = record?.zone ?? ''
      const name = label === '' ? zone : zone === '' ? label : `${label}.${zone}`
      return {
        type: String(record?.recordType ?? '').toUpperCase(),
        name,
        value: record?.requiredValue ?? '',
      }
    })
    .filter((record) => record.type !== '' && record.name !== '' && record.value !== '')
}

/**
 * Claims the host on Railway and reports the two records the zone must carry.
 *
 * The TXT is the half the CLI does not highlight: without `_railway-verify.<host>`
 * the domain sits in VALIDATING_OWNERSHIP forever while the CNAME looks perfect.
 */
export async function createCustomDomain(token, { projectId, environmentId, serviceId, domain, targetPort }, deps = {}) {
  const data = await graphql(
    token,
    `mutation($i:CustomDomainCreateInput!){customDomainCreate(input:$i){id domain status{dnsRecords{hostlabel recordType requiredValue zone}}}}`,
    { i: { projectId, environmentId, serviceId, domain, targetPort } },
    deps
  )
  const created = data?.customDomainCreate
  if (!created?.id) throw new ProvisionError(FAILURE.RAILWAY_API_FAILED)

  const records = normalizeDnsRecords(created.status)
  if (records.length === 0) throw new ProvisionError(FAILURE.RAILWAY_DOMAIN_RECORDS_MISSING)

  return { customDomainId: created.id, domain: created.domain ?? domain, records }
}

export async function customDomainStatus(token, customDomainId, deps = {}) {
  const data = await graphql(
    token,
    'query($id:String!){customDomain(id:$id){status{certificateStatus dnsRecords{hostlabel recordType requiredValue zone}}}}',
    { id: customDomainId },
    deps
  )
  const status = data?.customDomain?.status ?? {}
  return {
    certificateStatus: String(status.certificateStatus ?? 'UNKNOWN').toUpperCase(),
    records: normalizeDnsRecords(status),
  }
}

export async function deployService(token, { serviceId, environmentId }, deps = {}) {
  await graphql(
    token,
    'mutation($s:String!,$e:String!){serviceInstanceDeployV2(serviceId:$s,environmentId:$e)}',
    { s: serviceId, e: environmentId },
    deps
  )
}

export async function latestDeploymentStatus(token, { projectId, environmentId, serviceId }, deps = {}) {
  const data = await graphql(
    token,
    'query($p:String!,$e:String!,$s:String!){deployments(first:1,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{status}}}}',
    { p: projectId, e: environmentId, s: serviceId },
    deps
  )
  const [first] = nodes(data?.deployments)
  return String(first?.status ?? 'PENDING').toUpperCase()
}

const TERMINAL_FAILURES = new Set(['FAILED', 'CRASHED', 'REMOVED'])

export async function waitForDeployment(token, target, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const tries = deps.tries ?? 90
  const waitMs = deps.waitMs ?? 10_000

  for (let attempt = 0; attempt < tries; attempt += 1) {
    const status = await latestDeploymentStatus(token, target, deps)
    if (status === 'SUCCESS') return status
    if (TERMINAL_FAILURES.has(status)) throw new ProvisionError(FAILURE.RAILWAY_DEPLOY_FAILED)
    await sleep(waitMs)
  }
  throw new ProvisionError(FAILURE.RAILWAY_DEPLOY_FAILED)
}

/** Rollback primitive. Deleting the project takes its services and volumes with it. */
export async function deleteProject(token, projectId, deps = {}) {
  await graphql(token, 'mutation($id:String!){projectDelete(id:$id)}', { id: projectId }, deps)
}

/**
 * The shape Railway shows instead of a token: first four characters, four
 * asterisks, last four. Verified against a real account (spec §10.2) — in ten
 * tokens exactly one matched, so prefix plus suffix identifies a token uniquely.
 */
export function displayTokenFor(value) {
  if (typeof value !== 'string' || value.length < 8) throw new ProvisionError(FAILURE.RAILWAY_TOKEN_NOT_FOUND)
  return `${value.slice(0, 4)}-****-${value.slice(-4)}`
}

export async function findApiTokenId(token, deps = {}) {
  const data = await graphql(token, 'query{apiTokens(first:100){edges{node{id name displayToken}}}}', {}, deps)
  const wanted = displayTokenFor(token.reveal())
  const matches = nodes(data?.apiTokens).filter((entry) => entry?.displayToken === wanted)

  if (matches.length === 0) throw new ProvisionError(FAILURE.RAILWAY_TOKEN_NOT_FOUND)
  // Two tokens sharing both ends is astronomically unlikely and would mean
  // deleting the wrong one — a credential the visitor still uses elsewhere.
  // Refusing is the only safe branch.
  if (matches.length > 1) throw new ProvisionError(FAILURE.RAILWAY_TOKEN_AMBIGUOUS)
  return matches[0].id
}

export async function deleteApiToken(token, id, deps = {}) {
  await graphql(token, 'mutation($id:String!){apiTokenDelete(id:$id)}', { id }, deps)
}

/**
 * Destroys the token that ran the job and proves it.
 *
 * The proof is a call that has to fail. A delete mutation returning 200 is a
 * claim; a subsequent `me` that still answers means the credential outlived the
 * installation, and the visitor has to be told rather than reassured.
 *
 * Never throws: this runs in the finally of a job that may already be failing,
 * and a cleanup error must not replace the failure the user needs to read.
 */
export async function destroyToken(token, deps = {}) {
  let id
  try {
    id = await findApiTokenId(token, deps)
  } catch (error) {
    return { deleted: false, confirmed: false, code: error?.code ?? FAILURE.RAILWAY_API_FAILED }
  }

  try {
    await deleteApiToken(token, id, deps)
  } catch (error) {
    return { deleted: false, confirmed: false, code: error?.code ?? FAILURE.RAILWAY_API_FAILED }
  }

  // Only ONE error proves the token is gone: the API telling us it is not
  // authorised. Treating any thrown error as proof turned a rate limit — the
  // most likely state right after a provision that just made dozens of calls on
  // one account — into "we confirmed it no longer works", the strongest
  // sentence on the page, about a credential that grants total control of the
  // visitor's Railway account. Unreachable and api_failed say nothing about the
  // token; they say something about the network.
  const proof = async () => {
    try {
      await graphql(token, 'query{me{id}}', {}, deps)
      return { deleted: true, confirmed: false, code: null }
    } catch (error) {
      const code = error?.code
      if (code === FAILURE.RAILWAY_TOKEN_INVALID || code === FAILURE.RAILWAY_TOKEN_NOT_ACCOUNT) {
        return { deleted: true, confirmed: true, code: null }
      }
      return { deleted: true, confirmed: false, code: code ?? FAILURE.RAILWAY_API_FAILED }
    }
  }

  const first = await proof()
  if (first.confirmed || first.code === null) return first

  // One retry: a transient failure is worth a second look before telling
  // somebody to go delete a token by hand.
  await new Promise((resolve) => setTimeout(resolve, deps.proofRetryMs ?? 1500))
  return proof()
}
