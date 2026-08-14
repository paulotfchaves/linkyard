// The provider boundary.
//
// Linkyard installs on a Linux VPS and on Railway, and the two disagree about
// almost everything except the shape of the question: which DNS record points a
// host at this installation, and is its certificate ready. Two interfaces carry
// that disagreement so that provisioning — the part with the guards in it, and
// the part worth getting right once — never learns which mode it is running in.
//
// The split is DNS from infrastructure, not Cloudflare from Railway, because
// those two axes move independently: a VPS install still keeps its zone at
// Cloudflare, and the DNS-01 wildcard that makes a new host instant on a VPS is
// issued with the very same token the panel already holds.

export type ProviderErrorCode =
  /** The request never got an answer: DNS failure, timeout, unparseable body. */
  | 'network'
  /** The provider rejected the credential. */
  | 'unauthorized'
  /** The provider answered, and said no. */
  | 'api_error'
  /** The resource does not exist at the provider. */
  | 'not_found'
  /** An identifier failed validation here, before it could reach a URL path. */
  | 'invalid_input'
  /** The answer parsed, but not into the shape this adapter needs. */
  | 'unexpected_response'

/**
 * Every provider failure, as one closed set.
 *
 * The message is written for a log, never for a user, and it is assembled from
 * fields this adapter chose — never from a caught error object. An HTTP client
 * embeds the request in the error it throws, and the request carries the
 * Authorization header: re-throwing one is how a token ends up in a log file.
 */
export class ProviderError extends Error {
  code: ProviderErrorCode
  detail: string | null

  constructor(code: ProviderErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ProviderError'
    this.code = code
    this.detail = detail ?? null
  }
}

export type ZoneSummary = {
  id: string
  name: string
  accountId: string | null
  accountName: string | null
}

export type DnsRecord = {
  id: string
  /** Left as a string: an adapter must be able to report a record type it does not itself write. */
  type: string
  name: string
  content: string
  proxied: boolean
  ttl: number | null
}

/**
 * A record this panel is willing to create.
 *
 * `proxied` is deliberately absent rather than defaulted. Cloudflare's orange
 * cloud terminates TLS at Cloudflare, which stops the infrastructure provider
 * from ever proving control of the host, and the certificate then sits in
 * validation forever with nothing on screen explaining why. A field nobody can
 * set is a mistake nobody can make.
 */
export type NewDnsRecord = {
  type: 'CNAME' | 'TXT' | 'A'
  name: string
  content: string
}

export type TokenIdentity = {
  id: string
  /** The provider's own word: 'active', 'disabled', 'expired'. */
  status: string
  expiresOn: string | null
}

/**
 * How much of the account a token can reach.
 *
 * `zones: 'all'` is the dangerous case and the common one — Cloudflare's zone
 * selector defaults to every zone, and most people accept the default.
 *
 * `source` records how the answer was reached, because the two paths do not
 * carry the same weight. Read from the token's own policies, `zones` is what
 * the token grants. Derived from the zones the token can list, it is what the
 * token reaches *today*: an all-zones token on a one-zone account is
 * indistinguishable from a correctly scoped one until a second zone appears.
 */
export type TokenScope = {
  zones: string[] | 'all'
  permissions: string[]
  expiresOn: string | null
  source: 'policies' | 'zone_listing'
}

export interface DnsProvider {
  listZones(): Promise<ZoneSummary[]>
  /** Every record at exactly `name`, whatever its type — the guards need the ones we do not write. */
  findRecords(zoneId: string, name: string): Promise<DnsRecord[]>
  createRecord(zoneId: string, record: NewDnsRecord): Promise<DnsRecord>
  deleteRecord(zoneId: string, recordId: string): Promise<void>
  verifyToken(): Promise<TokenIdentity>
  tokenScope(): Promise<TokenScope>
}

export type CertStatus = 'pending' | 'issuing' | 'valid' | 'failed'

export type VerificationRecord = { name: string; content: string }

/**
 * What DNS has to say for a host to work.
 *
 * `verification` is not optional decoration. Railway will not finish issuing a
 * certificate until the TXT record proving ownership resolves, and a host
 * missing it reports "validating" indefinitely with no error anywhere. This
 * project lost hours to exactly that, twice.
 */
export type HostRequirement = {
  /** The provider's handle for this host, when it has one. Needed to remove it later. */
  hostId: string | null
  recordType: 'CNAME' | 'A'
  value: string
  verification: VerificationRecord | null
  /** True when the host already existed at the provider and was adopted rather than created. */
  reused: boolean
}

export type HostState = { certificate: CertStatus; reachable: boolean }

export type UsageSnapshot = {
  cpuVcpu: number | null
  memoryGb: number | null
  egressGb: number | null
  diskGb: number | null
  estimatedCost: number | null
}

export interface InfraProvider {
  ensureHost(host: string): Promise<HostRequirement>
  hostStatus(host: string): Promise<HostState>
  removeHost(host: string): Promise<void>
  /** null where there is no bill to read — a VPS on a flat monthly rate. */
  usage(): Promise<UsageSnapshot | null>
  /**
   * Is this record value one of ours?
   *
   * The single question behind the strongest guard in provisioning: a record
   * this installation did not create is never overwritten and never deleted.
   * Only the provider knows what its own targets look like, so only the
   * provider can answer.
   */
  /**
   * Whether an existing DNS record belongs to this installation.
   *
   * `expected` is the value this job's own ensureHost returned. Deciding from
   * the value's shape alone answers a different question — "does this look like
   * the provider" — and would let a second installation on the same domain
   * overwrite the first one's record.
   */
  ownsRecordValue(value: string, expected?: string | null): boolean

  /**
   * Whether a value has the shape of this provider's own targets.
   *
   * A hint, never an authorisation: it distinguishes "probably an earlier
   * install of this product, offer to replace it" from "somebody's live
   * service, do not offer anything".
   */
  looksLikeRailwayTarget(value: string): boolean
}

/** Trailing dots and case are DNS noise, and comparing them raw invents conflicts. */
export function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\.$/, '') === b.trim().toLowerCase().replace(/\.$/, '')
}
