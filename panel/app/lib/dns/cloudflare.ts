import type { Secret } from '@linkyard/core/secret'
import {
  ProviderError,
  type DnsProvider,
  type DnsRecord,
  type NewDnsRecord,
  type TokenIdentity,
  type TokenScope,
  type ZoneSummary,
} from '../infra/types.ts'

// Cloudflare, as a DNS provider.
//
// The scope gate below is the reason this file exists at all. Everything else
// here is four HTTP calls.

const API = 'https://api.cloudflare.com/client/v4'

// A Cloudflare zone id is always 32 lowercase hex characters. Validated before
// it is interpolated into a path, because the value arrives from a form and a
// path segment carrying `../` reaches a different endpoint than the one this
// code believes it is calling.
const ZONE_ID = /^[a-f0-9]{32}$/

const TIMEOUT_MS = 15_000
const MAX_PAGES = 20

type Envelope<T> = {
  success?: boolean
  result?: T | null
  errors?: { code?: number; message?: string }[]
  result_info?: { page?: number; total_pages?: number }
}

type CfZone = { id?: string; name?: string; account?: { id?: string; name?: string } | null }

type CfRecord = {
  id?: string
  type?: string
  name?: string
  content?: string
  proxied?: boolean
  ttl?: number
}

export type CfPolicy = {
  effect?: string
  resources?: Record<string, unknown>
  permission_groups?: { id?: string; name?: string }[]
}

type CfToken = {
  id?: string
  status?: string
  expires_on?: string | null
  policies?: CfPolicy[]
}

function messageOf(envelope: Envelope<unknown> | null, status: number): string {
  const first = envelope?.errors?.[0]
  if (first?.message) return first.message
  return `http ${status}`
}

// ------------------------------------------------------------ scope analysis

const ZONE_RESOURCE = /^com\.cloudflare\.api\.account\.zone\.([a-f0-9]{32})$/
const ZONE_WILDCARD = /^com\.cloudflare\.api\.account\.zone\.\*$/
// An account or user resource covers everything underneath it, which includes
// every zone in that account — present and future.
const ACCOUNT_RESOURCE = /^com\.cloudflare\.api\.(account|user)\.[a-f0-9]{32}$/

/**
 * Which zones a set of token policies can reach.
 *
 * Returns the literal string 'all' for anything unbounded — an account-wide
 * grant, a zone wildcard, or a resource key this code does not recognise.
 *
 * The unknown case resolving to 'all' is the important one. Cloudflare adds
 * resource kinds over time, and a parser that quietly ignores what it cannot
 * read would let a policy shape invented next year slip through the gate as
 * though it granted nothing. Unfamiliar breadth is treated as maximum breadth,
 * so the failure mode is a refusal the operator can see and argue with.
 *
 * Deny policies are ignored: they narrow, never widen, and a token that is
 * broad-with-exceptions is refused by the caller anyway.
 */
export function resolveZoneSet(policies: CfPolicy[]): string[] | 'all' {
  const zones = new Set<string>()

  for (const policy of policies) {
    if ((policy.effect ?? 'allow') !== 'allow') continue
    const resources = policy.resources
    if (!resources || typeof resources !== 'object') return 'all'

    for (const [key, value] of Object.entries(resources)) {
      const scoped = ZONE_RESOURCE.exec(key)
      if (scoped) {
        zones.add(scoped[1])
        continue
      }
      if (ZONE_WILDCARD.test(key)) return 'all'
      if (ACCOUNT_RESOURCE.test(key)) {
        // The nested form names the zones underneath; '*' is the whole account.
        if (value && typeof value === 'object') {
          for (const nested of Object.keys(value as Record<string, unknown>)) {
            const nestedZone = ZONE_RESOURCE.exec(nested)
            if (nestedZone) zones.add(nestedZone[1])
            else return 'all'
          }
          continue
        }
        return 'all'
      }
      return 'all'
    }
  }

  return [...zones]
}

/** The capabilities provisioning needs, named the way the refusal will name them. */
export type RequiredPermission = 'dns_edit' | 'zone_read'

function permissionsPresent(names: string[]): Set<RequiredPermission> {
  const present = new Set<RequiredPermission>()
  for (const raw of names) {
    const name = raw.toLowerCase()
    const writes = name.includes('write') || name.includes('edit')
    if (name.includes('dns') && writes) present.add('dns_edit')
    if (name.includes('zone') && (writes || name.includes('read'))) present.add('zone_read')
  }
  return present
}

export type ScopeVerdict =
  | { ok: true }
  | { ok: false; reason: 'all_zones'; zones: 'all' }
  | { ok: false; reason: 'extra_zones'; zones: string[] }
  | { ok: false; reason: 'wrong_zone'; zones: string[] }
  | { ok: false; reason: 'missing_permission'; missing: RequiredPermission[] }

/**
 * The gate. Nothing writes DNS until this returns ok.
 *
 * The rule is exact equality, not membership: the token's zone set must be the
 * one zone being provisioned and nothing else. That is stricter than it needs
 * to be for the operation to succeed, and deliberately so.
 *
 * Cloudflare's token form defaults its zone selector to *All zones*, and most
 * people accept the default without reading it. The resulting token carries DNS
 * edit over every domain that person owns — enough to repoint their MX records
 * and intercept their mail, from a panel they installed to shorten links. The
 * cost of refusing is that they create the token again, correctly, in about a
 * minute. The cost of accepting is unbounded and lands on them, not on us.
 */
export function assertZoneScope(scope: TokenScope, zoneId: string): ScopeVerdict {
  if (scope.zones === 'all') return { ok: false, reason: 'all_zones', zones: 'all' }

  const zones = scope.zones
  if (!zones.includes(zoneId)) return { ok: false, reason: 'wrong_zone', zones }
  if (zones.length !== 1) return { ok: false, reason: 'extra_zones', zones }

  // A scope inferred from the zone listing carries no permission names at all,
  // and refusing it for a permission nobody could read would refuse every
  // correctly scoped token in practice — the token detail endpoint needs a
  // permission a DNS token has no reason to hold. What that scope proves is
  // reach, which is the part this gate exists for.
  if (scope.source === 'zone_listing') return { ok: true }

  const present = permissionsPresent(scope.permissions)
  const missing = (['dns_edit', 'zone_read'] as RequiredPermission[]).filter(
    (permission) => !present.has(permission)
  )
  if (missing.length > 0) return { ok: false, reason: 'missing_permission', missing }

  return { ok: true }
}

// ----------------------------------------------------------------- the client

export class CloudflareDns implements DnsProvider {
  #token: Secret
  #timeoutMs: number

  constructor(token: Secret, options: { timeoutMs?: number } = {}) {
    this.#token = token
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  }

  async #request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<Envelope<T>> {
    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          // The one place the token is revealed. Everywhere else it is a Secret
          // that prints as [redacted], including inside a thrown error.
          authorization: `Bearer ${this.#token.reveal()}`,
          'content-type': 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      // The caught error is dropped rather than wrapped: fetch embeds the
      // request — and with it the Authorization header — in what it throws.
      throw new ProviderError('network', 'cloudflare did not answer')
    }

    let envelope: Envelope<T> | null = null
    try {
      envelope = (await response.json()) as Envelope<T>
    } catch {
      envelope = null
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('unauthorized', messageOf(envelope, response.status))
    }
    if (response.status === 404) {
      throw new ProviderError('not_found', messageOf(envelope, response.status))
    }
    if (!response.ok || envelope?.success !== true) {
      throw new ProviderError('api_error', messageOf(envelope, response.status))
    }
    return envelope
  }

  #zonePath(zoneId: string, suffix = ''): string {
    if (!ZONE_ID.test(zoneId)) throw new ProviderError('invalid_input', 'not a cloudflare zone id')
    return `/zones/${zoneId}${suffix}`
  }

  async verifyToken(): Promise<TokenIdentity> {
    const envelope = await this.#request<{ id?: string; status?: string; expires_on?: string | null }>(
      '/user/tokens/verify'
    )
    const result = envelope.result
    if (!result?.id) throw new ProviderError('unexpected_response', 'verify returned no token id')
    return {
      id: result.id,
      status: result.status ?? 'unknown',
      expiresOn: result.expires_on ?? null,
    }
  }

  /**
   * What the token can reach.
   *
   * Two paths, because the direct one is frequently unavailable: reading a
   * token's own detail needs `User API Tokens Read`, which a DNS token has no
   * reason to carry. When that call is refused the zone set is derived from the
   * zones the token can list instead — which is what the token reaches, if not
   * what it was granted. The difference is recorded in `source` so the caller
   * can say which one it is looking at rather than implying certainty.
   */
  async tokenScope(): Promise<TokenScope> {
    const identity = await this.verifyToken()

    let token: CfToken | null = null
    try {
      const envelope = await this.#request<CfToken>(`/user/tokens/${encodeURIComponent(identity.id)}`)
      token = envelope.result ?? null
    } catch (error) {
      // Only a refusal falls back. A network failure is a network failure, and
      // pretending otherwise would report a scope built from a listing that
      // never happened.
      if (!(error instanceof ProviderError)) throw error
      if (error.code !== 'unauthorized' && error.code !== 'not_found') throw error
    }

    if (token?.policies) {
      return {
        zones: resolveZoneSet(token.policies),
        permissions: token.policies.flatMap((policy) =>
          (policy.permission_groups ?? []).map((group) => group.name ?? '').filter(Boolean)
        ),
        expiresOn: token.expires_on ?? identity.expiresOn,
        source: 'policies',
      }
    }

    const zones = await this.listZones()
    return {
      zones: zones.map((zone) => zone.id),
      permissions: [],
      expiresOn: identity.expiresOn,
      source: 'zone_listing',
    }
  }

  async listZones(): Promise<ZoneSummary[]> {
    const zones: ZoneSummary[] = []

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const envelope = await this.#request<CfZone[]>(`/zones?per_page=50&page=${page}`)
      for (const zone of envelope.result ?? []) {
        if (!zone.id || !zone.name) continue
        zones.push({
          id: zone.id,
          name: zone.name,
          accountId: zone.account?.id ?? null,
          accountName: zone.account?.name ?? null,
        })
      }
      const totalPages = envelope.result_info?.total_pages ?? 1
      if (page >= totalPages) break
    }

    return zones
  }

  async findRecords(zoneId: string, name: string): Promise<DnsRecord[]> {
    const path = this.#zonePath(
      zoneId,
      `/dns_records?name=${encodeURIComponent(name)}&per_page=100`
    )
    const envelope = await this.#request<CfRecord[]>(path)
    return (envelope.result ?? [])
      .filter((record): record is CfRecord & { id: string } => typeof record.id === 'string')
      .map((record) => ({
        id: record.id,
        type: record.type ?? '',
        name: record.name ?? name,
        content: record.content ?? '',
        proxied: record.proxied === true,
        ttl: typeof record.ttl === 'number' ? record.ttl : null,
      }))
  }

  async createRecord(zoneId: string, record: NewDnsRecord): Promise<DnsRecord> {
    const path = this.#zonePath(zoneId, '/dns_records')
    const envelope = await this.#request<CfRecord>(path, {
      method: 'POST',
      body: {
        type: record.type,
        name: record.name,
        content: record.content,
        // Hard-coded, not defaulted, and not reachable from the caller. The
        // orange cloud terminates TLS at Cloudflare, so the infrastructure
        // provider can never prove control of the host and the certificate
        // waits in validation with nothing on screen to explain it.
        proxied: false,
        // 1 means automatic. A long TTL on a record that was just repointed is
        // how a redirect keeps resolving to yesterday's target.
        ttl: 1,
      },
    })
    const created = envelope.result
    if (!created?.id) throw new ProviderError('unexpected_response', 'create returned no record')
    return {
      id: created.id,
      type: created.type ?? record.type,
      name: created.name ?? record.name,
      content: created.content ?? record.content,
      proxied: created.proxied === true,
      ttl: typeof created.ttl === 'number' ? created.ttl : null,
    }
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(recordId)) {
      throw new ProviderError('invalid_input', 'not a cloudflare record id')
    }
    await this.#request(this.#zonePath(zoneId, `/dns_records/${recordId}`), { method: 'DELETE' })
  }

  /** The zone as Cloudflare sees it — the check that proves the token can read it. */
  async getZone(zoneId: string): Promise<ZoneSummary> {
    const envelope = await this.#request<CfZone>(this.#zonePath(zoneId))
    const zone = envelope.result
    if (!zone?.id || !zone.name) throw new ProviderError('not_found', 'zone not visible to this token')
    return {
      id: zone.id,
      name: zone.name,
      accountId: zone.account?.id ?? null,
      accountName: zone.account?.name ?? null,
    }
  }
}
