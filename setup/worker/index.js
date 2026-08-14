// The operator's entire persistence: an email address and a date.
//
// Adapted from the email-license Worker that fronts the n8n kit, with four
// deliberate departures (spec §10.5).
//
// There is no `email()` handler and the wrangler config declares no catch-all.
// Linkyard has no licence mail to capture, so inheriting that handler would keep
// a route that writes arbitrary content from any sender on the internet into KV,
// unauthenticated and unbounded — attack surface bought with no feature.
//
// There is one route. `POST /install`, authenticated, size-capped, strictly
// validated; everything else is 404, including GET on the same path. The
// reference Worker answered 200 on a public path and compared its secret with
// `!==`, which leaks the length of the match one request at a time.
//
// There is one key per install. A read-modify-write counter on a single key is
// wrong twice over: KV accepts one write per second per key, and it is
// eventually consistent, so concurrent installs read the same value and one
// increment silently disappears. Counting is a `list()` — slower, and correct.

const MAX_BODY_BYTES = 1024
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,20}$/
const LOCALES = new Set(['en', 'pt-BR'])
const ALLOWED_FIELDS = new Set(['email', 'locale'])
const PREFIX = 'install:'

function notFound() {
  // 404 rather than 401 or 405 on everything else: a 405 confirms the path
  // exists, which is the first thing worth knowing about an endpoint.
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first, which equalises length before any byte is
 * compared — otherwise the comparison itself, however careful, still discloses
 * how long the secret is. `crypto.subtle.timingSafeEqual` is a Workers
 * extension; the manual fallback keeps this file runnable under `node --test`.
 */
export async function timingSafeEqual(given, expected) {
  const encoder = new TextEncoder()
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(given ?? ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(expected ?? ''))),
  ])

  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(left, right)

  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

/**
 * The whole schema, and it is closed.
 *
 * An unknown field is a rejection rather than something to ignore: the promise
 * printed on the setup panel is that this store holds an address and a date, and
 * quietly accepting a field nobody declared is how that stops being true.
 */
export function parseInstall(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BODY_BYTES) return null

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  for (const key of Object.keys(payload)) if (!ALLOWED_FIELDS.has(key)) return null

  const email = String(payload.email ?? '').trim().toLowerCase()
  if (!EMAIL.test(email)) return null

  const locale = payload.locale === undefined ? 'en' : String(payload.locale)
  if (!LOCALES.has(locale)) return null

  return { email, locale }
}

/** Derived, never stored. See the note at the top of this file. */
export async function countInstalls(store) {
  let total = 0
  let cursor
  for (let page = 0; page < 100; page += 1) {
    const result = await store.list({ prefix: PREFIX, cursor })
    total += result.keys.length
    if (result.list_complete) return total
    cursor = result.cursor
  }
  return total
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/install') return notFound()

    const secret = env.INSTALL_SECRET
    if (!secret) return notFound()
    if (!(await timingSafeEqual(request.headers.get('x-install-secret'), secret))) {
      return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } })
    }

    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 })

    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 })

    const install = parseInstall(text)
    if (!install) return new Response('Bad request', { status: 400 })

    await env.installs.put(
      `${PREFIX}${crypto.randomUUID()}`,
      JSON.stringify({ email: install.email, installed_at: new Date().toISOString(), locale: install.locale })
    )

    return new Response(JSON.stringify({ installs: await countInstalls(env.installs) }), {
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  },
}
