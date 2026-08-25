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

  // The only reveal in this module, and it happens OUTSIDE the try below.
  // Inside it, a caller passing a bare string instead of a Secret throws a
  // TypeError that the catch would swallow and report as "Cloudflare did not
  // answer" — sending whoever reads that message to check a network that is
  // perfectly fine. Only the fetch itself may mean unreachable.
  const authorization = `Bearer ${token.reveal()}`

  let response
  try {
    response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        authorization,
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

  // Checking only the suffix let anything through on the left of it: a host
  // with a space in it, or an empty label from a doubled dot, both ended in
  // `.paulochaves.dev` and both were accepted, then handed to Cloudflare to
  // refuse — turning a typo into an API error instead of a field message.
  const prefix = normalized.slice(0, -(zone.length + 1))
  const labels = prefix.split('.')
  // A leading underscore is allowed because this installer creates
  // `_railway-verify.<host>` itself, and the same shape covers `_acme-challenge`
  // and friends. Hostname rules would forbid it; DNS verification records rely
  // on it, and a stricter pattern here breaks the product's own flow.
  const LABEL = /^_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  if (labels.length === 0 || !labels.every((label) => LABEL.test(label))) {
    throw new ProvisionError(FAILURE.DNS_NAME_FORBIDDEN, { host: normalized })
  }

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
// 81053/81057/81058 are Cloudflare's "this name is taken" family. Anything else
// is a different problem and must not wear this label.
const DUPLICATE_CODES = new Set([81053, 81057, 81058])

function isDuplicateError(errors) {
  return (errors ?? []).some(
    (error) =>
      DUPLICATE_CODES.has(Number(error?.code)) || /already exists/i.test(String(error?.message ?? ''))
  )
}

export async function createRecord(token, zoneId, record, deps = {}) {
  const existing = await findRecords(token, zoneId, record.name, deps)
  if (existing.length > 0) {
    throw new ProvisionError(FAILURE.DNS_RECORD_EXISTS, { name: record.name, type: existing[0].type })
  }

  const { ok, status, result, errors } = await request(
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

  // A duplicate is a specific Cloudflare error code, not any 400. Reading the
  // status alone reported "that record already exists" for every malformed
  // request — a bad content value, an unsupported type, a name Cloudflare
  // rejects — and sent the operator hunting for a record that was never there.
  if (!ok && isDuplicateError(errors)) {
    throw new ProvisionError(FAILURE.DNS_RECORD_EXISTS, { name: record.name, type: record.type })
  }
  if (!ok || !result?.id) throw apiFailure(status)

  return { id: result.id, type: record.type, name: record.name, value: record.value }
}

export async function deleteRecord(token, zoneId, recordId, deps = {}) {
  const { ok, status } = await request(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' }, deps)
  if (!ok) throw apiFailure(status)
}
