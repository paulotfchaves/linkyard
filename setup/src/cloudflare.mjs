// The Cloudflare side of a provision: verify the token, resolve the zone, write
// two records — and refuse to touch anything that already exists.
//
// Create-only is the whole posture (control 4). An upsert here would be a single
// PUT away from pointing a production hostname at Railway and losing the old
// value in the same second, with no undo: the previous target is gone and so is
// the token that could have restored it. Every write is preceded by a read, and
// a name that already answers ends the job instead of overwriting it.

import { FAILURE, ProvisionError } from './secret.mjs'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

async function request(token, path, init, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = deps.cloudflareApi ?? CLOUDFLARE_API

  let response
  try {
    response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        // The only reveal in this module.
        authorization: `Bearer ${token.reveal()}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw new ProvisionError(FAILURE.CLOUDFLARE_UNREACHABLE)
  }

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  // Cloudflare answers 200 with `success: false` often enough that status alone
  // is not a verdict.
  const ok = response.ok && body?.success !== false
  return { ok, status: response.status, result: body?.result ?? null, errors: body?.errors ?? [] }
}

function apiFailure(status) {
  return new ProvisionError(status === 401 || status === 403 ? FAILURE.CLOUDFLARE_TOKEN_INVALID : FAILURE.CLOUDFLARE_API_FAILED)
}

/** `GET /user/tokens/verify` — the one call every Cloudflare token can make. */
export async function verifyToken(token, deps = {}) {
  const { ok, status, result } = await request(token, '/user/tokens/verify', { method: 'GET' }, deps)
  if (!ok || !result?.id) throw apiFailure(status)
  if (String(result.status ?? 'active') !== 'active') throw new ProvisionError(FAILURE.CLOUDFLARE_TOKEN_INVALID)
  return { tokenId: result.id }
}

/**
 * Reads the token's own record to check the TTL the guide asks for.
 *
 * Reading it needs `API Tokens: Read`, which the provision itself does not need,
 * so a token without that permission is normal and not an error. When the record
 * *is* readable and carries no expiry, that is a promise the installer cannot
 * keep — the Cloudflare credential cannot be deleted the way the Railway one is
 * (that needs `API Tokens: Edit`, more power than the job requires), and TTL is
 * the only thing that ends it. So: refuse when we can see it is missing, stay
 * quiet when we cannot see at all.
 */
export async function describeToken(token, tokenId, deps = {}) {
  const { ok, result } = await request(token, `/user/tokens/${tokenId}`, { method: 'GET' }, deps)
  if (!ok || !result) return { readable: false, expiresOn: null }
  return { readable: true, expiresOn: result.expires_on ?? null }
}

export async function listZones(token, deps = {}) {
  const { ok, status, result } = await request(token, '/zones?per_page=50', { method: 'GET' }, deps)
  if (!ok || !Array.isArray(result)) throw apiFailure(status)
  return result.map((zone) => ({ id: zone.id, name: zone.name }))
}

/**
 * Resolves the zone and enforces that the token is scoped to it (control 3).
 *
 * A token that can see several zones is an "All zones" token: one typo in the
 * apex and the installer writes into a zone the visitor did not mean to expose.
 * Refusing here costs one minute of re-issuing a token; not refusing costs a
 * record in the wrong domain.
 */
export async function resolveZone(token, apex, deps = {}) {
  const zones = await listZones(token, deps)
  if (zones.length > 1) throw new ProvisionError(FAILURE.CLOUDFLARE_TOKEN_UNSCOPED, { seen: zones.length })

  const zone = zones.find((candidate) => candidate.name === apex)
  if (!zone) throw new ProvisionError(FAILURE.CLOUDFLARE_ZONE_NOT_FOUND, { apex })
  return zone
}

/** The full verification the confirm screen is built from (control 6). */
export async function inspectCredential(token, apex, deps = {}) {
  const { tokenId } = await verifyToken(token, deps)
  const zone = await resolveZone(token, apex, deps)
  const { readable, expiresOn } = await describeToken(token, tokenId, deps)
  if (readable && !expiresOn) throw new ProvisionError(FAILURE.CLOUDFLARE_TOKEN_NO_TTL)
  return { zoneId: zone.id, zoneName: zone.name, expiresOn }
}

/**
 * The names this installer is allowed to create.
 *
 * The apex and `www` are refused outright: they are where the visitor's actual
 * website lives, and no wording on a confirmation screen makes overwriting a
 * live homepage recoverable.
 */
export function assertCreatableHost(apex, host) {
  const normalized = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  const zone = String(apex ?? '').trim().toLowerCase().replace(/\.$/, '')

  if (normalized === '' || zone === '') throw new ProvisionError(FAILURE.DNS_NAME_FORBIDDEN, { host: normalized })
  if (normalized === zone || normalized === `www.${zone}`) {
    throw new ProvisionError(FAILURE.DNS_NAME_FORBIDDEN, { host: normalized })
  }
  if (!normalized.endsWith(`.${zone}`)) throw new ProvisionError(FAILURE.DNS_NAME_FORBIDDEN, { host: normalized })
  return normalized
}

export async function findRecords(token, zoneId, name, deps = {}) {
  const { ok, status, result } = await request(
    token,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    { method: 'GET' },
    deps
  )
  if (!ok || !Array.isArray(result)) throw apiFailure(status)
  return result.map((record) => ({ id: record.id, type: record.type, name: record.name, content: record.content }))
}

/**
 * Creates one record, after proving the name is free.
 *
 * `proxied: false` is not a preference. The orange cloud terminates TLS at
 * Cloudflare, so Railway never sees the ACME challenge and the certificate never
 * issues — the domain sits pending until somebody thinks to look at a toggle.
 */
export async function createRecord(token, zoneId, record, deps = {}) {
  const existing = await findRecords(token, zoneId, record.name, deps)
  if (existing.length > 0) {
    throw new ProvisionError(FAILURE.DNS_RECORD_EXISTS, { name: record.name, type: existing[0].type })
  }

  const { ok, status, result } = await request(
    token,
    `/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      body: JSON.stringify({
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: 60,
        proxied: false,
        comment: 'Created by the Linkyard installer',
      }),
    },
    deps
  )

  // Cloudflare rejects a duplicate CNAME with its own code; treat any refusal on
  // a name we just read as free as the same "somebody got there first" outcome.
  if (!ok && status === 400) throw new ProvisionError(FAILURE.DNS_RECORD_EXISTS, { name: record.name, type: record.type })
  if (!ok || !result?.id) throw apiFailure(status)

  return { id: result.id, type: record.type, name: record.name, value: record.value }
}

export async function deleteRecord(token, zoneId, recordId, deps = {}) {
  const { ok, status } = await request(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' }, deps)
  if (!ok) throw apiFailure(status)
}
