import type { Secret } from '@linkyard/core/secret'
import {
  ProviderError,
  sameHost,
  type CertStatus,
  type HostRequirement,
  type HostState,
  type InfraProvider,
  type UsageSnapshot,
} from './types.ts'

// Railway, as an infrastructure provider.
//
// Two details in here were paid for in outage time and are the reason this is
// an adapter rather than three inline fetches: the certificate enum, and the
// ownership TXT record.

const ENDPOINT = 'https://backboard.railway.com/graphql/v2'
const TIMEOUT_MS = 20_000

// Every target Railway routes through sits under this suffix. It is the whole
// basis of "is this record ours" — see ownsRecordValue.
const RAILWAY_TARGET = /(^|\.)up\.railway\.app\.?$/i

const CERT_PREFIX = 'CERTIFICATE_STATUS_TYPE_'

/**
 * Railway's certificate enum, mapped by exact suffix.
 *
 * `CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP` contains the substring VALID.
 * A `.includes('VALID')` test — the obvious way to write this — reports a host
 * as ready while it is still waiting for a DNS record that may not even exist
 * yet, and the panel then hands the operator a domain that answers nothing.
 * The comparison is equality against the suffix, never containment.
 */
export function toCertStatus(raw: string | null | undefined): CertStatus {
  const value = (raw ?? '').toUpperCase()
  const suffix = value.startsWith(CERT_PREFIX) ? value.slice(CERT_PREFIX.length) : value

  switch (suffix) {
    case 'VALID':
      return 'valid'
    case 'ISSUING':
      return 'issuing'
    case 'VALIDATING_OWNERSHIP':
      return 'pending'
    case 'ISSUE_FAILED':
      return 'failed'
    default:
      // UNSPECIFIED, an empty string, or a member added after this was written.
      // Pending is the only safe reading: it keeps the caller polling instead of
      // declaring either success or failure on a value nobody has seen.
      return 'pending'
  }
}

type GraphQlResult<T> = { data: T | null; errors: string[] }

type RailwayDnsRecord = { recordType?: string | null; requiredValue?: string | null }

type RailwayDomainStatus = {
  certificateStatus?: string | null
  verificationToken?: string | null
  verificationDnsHost?: string | null
  dnsRecords?: RailwayDnsRecord[] | null
}

type RailwayCustomDomain = { id?: string; domain?: string; status?: RailwayDomainStatus | null }

// Two field sets, tried in order. Railway has renamed status fields before, and
// a query naming one that no longer exists fails whole rather than partially —
// which would take domain provisioning down for a field the flow can live
// without.
const STATUS_FULL =
  'certificateStatus verificationToken verificationDnsHost dnsRecords { requiredValue recordType }'
const STATUS_MIN = 'certificateStatus dnsRecords { requiredValue recordType }'

function isSchemaFieldError(errors: string[]): boolean {
  return errors.some((message) => /cannot query field|unknown field/i.test(message))
}

export type RailwayTarget = {
  token: Secret
  projectId: string
  environmentId: string
  serviceId: string
  /** The port the edge listens on inside the container. */
  targetPort?: number
}

export class RailwayInfra implements InfraProvider {
  #target: RailwayTarget
  #timeoutMs: number

  constructor(target: RailwayTarget, options: { timeoutMs?: number } = {}) {
    this.#target = target
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  }

  async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<GraphQlResult<T>> {
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          // The only reveal in this file.
          authorization: `Bearer ${this.#target.token.reveal()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      // Dropped rather than wrapped: the thrown error carries the request, and
      // the request carries the Authorization header.
      throw new ProviderError('network', 'railway did not answer')
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('unauthorized', 'railway rejected the token')
    }

    type GraphQlBody = { data?: T; errors?: { message?: string }[] }
    let body: GraphQlBody | null = null
    try {
      body = (await response.json()) as GraphQlBody
    } catch {
      body = null
    }
    if (!body) throw new ProviderError('unexpected_response', `railway http ${response.status}`)

    return {
      data: body.data ?? null,
      // GraphQL reports an expired token as HTTP 200 with an errors array, so
      // the status code alone never decides whether this worked.
      errors: (body.errors ?? []).map((error) => error.message ?? 'unknown').filter(Boolean),
    }
  }

  /**
   * Whether this installation may overwrite a record that already exists.
   *
   * The suffix alone answers "is this some Railway hostname", which is not the
   * question. A person running two Railway projects on one domain would have
   * the second install happily overwrite the first one's CNAME, because both
   * end in up.railway.app. Ownership is only proven by the value THIS job's own
   * ensureHost returned; everything else — Railway-shaped or not — needs an
   * explicit decision from the person.
   */
  ownsRecordValue(value: string, expected?: string | null): boolean {
    const actual = value.trim().replace(/\.$/, '').toLowerCase()
    if (expected) {
      return actual === expected.trim().replace(/\.$/, '').toLowerCase()
    }
    // Without an expected value there is nothing to compare against, so the
    // honest answer is no. Returning true here is what made the suffix test
    // look sufficient.
    return false
  }

  /** A Railway-shaped target, which is a hint for the UI — never authorisation. */
  looksLikeRailwayTarget(value: string): boolean {
    return RAILWAY_TARGET.test(value.trim())
  }

  async #findDomain(host: string): Promise<RailwayCustomDomain | null> {
    const { projectId, environmentId, serviceId } = this.#target

    for (const fields of [STATUS_FULL, STATUS_MIN]) {
      const { data, errors } = await this.#graphql<{
        domains: { customDomains?: RailwayCustomDomain[] } | null
      }>(
        `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
           domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
             customDomains { id domain status { ${fields} } }
           }
         }`,
        { projectId, environmentId, serviceId }
      )

      if (data?.domains) {
        const found = (data.domains.customDomains ?? []).find((domain) =>
          sameHost(domain.domain ?? '', host)
        )
        return found ?? null
      }
      if (fields === STATUS_FULL && isSchemaFieldError(errors)) continue
      throw new ProviderError('api_error', errors.join(' · ') || 'railway did not list domains')
    }

    return null
  }

  #requirementOf(
    host: string,
    domain: RailwayCustomDomain,
    reused: boolean,
    degraded = false
  ): HostRequirement {
    const status = domain.status ?? {}
    const cname = (status.dnsRecords ?? []).find((record) =>
      (record.recordType ?? '').toUpperCase().includes('CNAME')
    )?.requiredValue

    if (!cname) {
      throw new ProviderError('unexpected_response', 'railway returned no CNAME target')
    }

    // The TXT that proves ownership. Without it the certificate sits in
    // VALIDATING_OWNERSHIP forever and nothing — not the CLI, not the dashboard
    // — says why. The name is derived when the API omits it because the shape
    // is fixed and a missing record is the failure that costs hours; a spurious
    // one is a TXT record nobody reads.
    // A freshly created domain with no verification token is not a domain that
    // needs no verification — it is a response that did not carry one, which
    // the STATUS_MIN fallback cannot even ask for. Continuing would skip the
    // TXT and leave the certificate stuck in VALIDATING_OWNERSHIP forever, with
    // the provisioning UI reporting every step green.
    if (!status.verificationToken && !reused) {
      throw new ProviderError(
        'unexpected_response',
        degraded
          ? 'railway did not return the ownership token (schema fallback in use); retry once the API exposes verificationToken'
          : 'railway created the domain without an ownership token'
      )
    }

    const verification = status.verificationToken
      ? {
          name: status.verificationDnsHost || `_railway-verify.${host}`,
          content: status.verificationToken,
        }
      : null

    return {
      hostId: domain.id ?? null,
      recordType: 'CNAME',
      value: cname,
      verification,
      reused,
    }
  }

  async ensureHost(host: string): Promise<HostRequirement> {
    const { projectId, environmentId, serviceId, targetPort } = this.#target
    const input = {
      domain: host,
      environmentId,
      projectId,
      serviceId,
      ...(targetPort === undefined ? {} : { targetPort }),
    }

    for (const fields of [STATUS_FULL, STATUS_MIN]) {
      const { data, errors } = await this.#graphql<{
        customDomainCreate: RailwayCustomDomain | null
      }>(
        `mutation customDomainCreate($input: CustomDomainCreateInput!) {
           customDomainCreate(input: $input) { id status { ${fields} } }
         }`,
        { input }
      )

      if (data?.customDomainCreate) {
        return this.#requirementOf(host, data.customDomainCreate, false)
      }

      const message = errors.join(' · ')
      // Adopting a host this installation already registered is what makes the
      // whole flow resumable: a job interrupted after the mutation and before
      // the DNS write finds its own domain here rather than a dead end.
      if (/already (exists|in use|registered|taken)/i.test(message)) {
        const existing = await this.#findDomain(host)
        if (!existing) throw new ProviderError('not_found', 'railway claims the host exists but does not list it')
        return this.#requirementOf(host, existing, true)
      }
      if (fields === STATUS_FULL && isSchemaFieldError(errors)) continue
      throw new ProviderError('api_error', message || 'railway refused the host')
    }

    throw new ProviderError('api_error', 'railway refused the host')
  }

  /**
   * What Railway thinks of the host.
   *
   * `reachable` is Railway's view — the host is attached and its certificate is
   * valid, so the edge is being routed traffic. It is not proof that the host
   * answers, which only a request to the host can establish, and which
   * provisioning does separately.
   */
  async hostStatus(host: string): Promise<HostState> {
    const domain = await this.#findDomain(host)
    if (!domain) return { certificate: 'pending', reachable: false }

    const certificate = toCertStatus(domain.status?.certificateStatus)
    return { certificate, reachable: certificate === 'valid' }
  }

  async removeHost(host: string): Promise<void> {
    const domain = await this.#findDomain(host)
    // Already gone counts as removed: a retry after a partial failure must not
    // be the thing that fails.
    if (!domain?.id) return

    const { data, errors } = await this.#graphql<{ customDomainDelete: boolean }>(
      `mutation customDomainDelete($id: String!) { customDomainDelete(id: $id) }`,
      { id: domain.id }
    )
    if (!data && errors.length > 0 && !errors.some((message) => /not found/i.test(message))) {
      throw new ProviderError('api_error', errors.join(' · '))
    }
  }

  async usage(): Promise<UsageSnapshot | null> {
    const { data, errors } = await this.#graphql<{
      estimatedUsage?: { measurement?: string; estimatedValue?: number }[]
    }>(
      `query linkyardUsage($projectId: String!) {
         estimatedUsage(projectId: $projectId) { measurement estimatedValue }
       }`,
      { projectId: this.#target.projectId }
    )
    if (errors.length > 0 || !Array.isArray(data?.estimatedUsage)) return null

    const values = new Map<string, number>()
    for (const entry of data.estimatedUsage) {
      if (typeof entry?.measurement === 'string' && Number.isFinite(entry.estimatedValue)) {
        values.set(entry.measurement.toUpperCase(), entry.estimatedValue as number)
      }
    }

    return {
      cpuVcpu: values.get('CPU_USAGE') ?? null,
      memoryGb: values.get('MEMORY_USAGE_GB') ?? null,
      egressGb: values.get('NETWORK_TX_GB') ?? null,
      diskGb: values.get('DISK_USAGE_GB') ?? values.get('EPHEMERAL_DISK_USAGE_GB') ?? null,
      estimatedCost: values.get('ESTIMATED_USAGE_USD') ?? values.get('ESTIMATED_COST_USD') ?? null,
    }
  }
}
