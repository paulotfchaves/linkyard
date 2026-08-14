// Resolution: Host header plus path in, redirect out.
//
// This is the only code path a visitor waits on, so it is deliberately two
// queries at most and usually one: the host row is cached in memory because the
// set of hosts changes a few times a month while the lookup happens on every
// single request, and the link row is a single index hit on
// links (subdomain_id, lower(slug)) WHERE deleted_at IS NULL.
//
// Nothing here writes. The click is recorded after the response has already
// left, by collect.mjs.

// One implementation of the destination rules, not two that drift. The panel
// composes a preview with this same function, and a preview that disagrees with
// the redirect is worse than no preview.
import { buildTargetUrl } from '../../panel/app/lib/links.ts'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX = 1_000

/**
 * Lowercase, strip the port, strip the root dot.
 *
 * `example.com.` is the fully-qualified spelling of the same name and some
 * clients send it; `subdomains.host` never carries the trailing dot, so without
 * this the request resolves to nothing.
 */
/**
 * Only temporary redirects leave this service.
 *
 * The schema stops 301 and 308 from being stored (migration 006), and this
 * clamps anything that arrives anyway — an old row, an import, a future write
 * path that forgets. A permanent redirect is cached by the browser until the
 * cache is cleared, so one would silently break destination changes for
 * everyone who had already clicked, with no way to repair it.
 */
function temporaryStatus(value) {
  return value === 307 ? 307 : 302
}

export function normalizeHost(raw) {
  if (typeof raw !== 'string') return ''
  let host = raw.trim().toLowerCase()
  // An IPv6 literal is bracketed, and its colons are not a port separator.
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close !== -1) return host.slice(0, close + 1)
  }
  host = host.replace(/:\d+$/, '')
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

/**
 * A bounded, TTL'd map of host → site row.
 *
 * Bounded because the key is the Host header, which is written by whoever sends
 * the request: an unbounded map keyed on it is a memory-exhaustion vector
 * reachable by anyone who can reach the edge. Misses are cached too, for the
 * same reason — a flood of junk hosts must not become a flood of queries.
 */
export function createHostCache({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
  const entries = new Map()

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (Date.now() >= entry.expires) {
        entries.delete(key)
        return undefined
      }
      return entry
    },
    set(key, value) {
      // Map iterates in insertion order, so the first key is the oldest.
      if (entries.size >= max && !entries.has(key)) {
        entries.delete(entries.keys().next().value)
      }
      entries.set(key, { value, expires: Date.now() + ttlMs })
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

const SITE_SQL = `
  SELECT s.id, s.host, s.fallback_url, s.active,
         s.root_policy AS sub_root_policy, s.root_target AS sub_root_target,
         d.apex, d.active AS domain_active,
         d.root_policy AS domain_root_policy, d.root_target AS domain_root_target
    FROM subdomains s
    JOIN domains d ON d.id = s.domain_id
   WHERE lower(s.host) = $1
   LIMIT 1`

/** The site (subdomain joined to its domain) serving a host, or null. */
export async function lookupHost(pool, host, cache) {
  const cached = cache?.get(host)
  if (cached) return cached.value

  const { rows } = await pool.query(SITE_SQL, [host])
  const site = rows[0] ?? null
  cache?.set(host, site)
  return site
}

const LINK_SQL = `
  SELECT id, target_url, redirect_type, params, pass_through, active,
         expires_at, fallback_url,
         utm_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term
    FROM links
   WHERE subdomain_id = $1 AND lower(slug) = lower($2) AND deleted_at IS NULL
   LIMIT 1`

/** The path minus its slashes. Percent-escapes are decoded when they parse. */
export function slugFrom(pathname) {
  const raw = String(pathname ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    // A malformed escape is not worth a 500; it simply matches no link.
    return raw
  }
}

function absoluteUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * The courtesy destination when the link itself cannot serve: the link's own
 * fallback, then the subdomain's.
 *
 * Always a 302 regardless of the link's redirect_type. A fallback is a stopgap
 * an operator changes the moment they notice it; caching one permanently in
 * every browser that saw it would outlive the problem it papers over.
 */
function fallbackFor(link, site) {
  const own = absoluteUrl(link?.fallback_url)
  if (own) return { location: own, via: 'link_fallback' }
  const shared = absoluteUrl(site?.fallback_url)
  if (shared) return { location: shared, via: 'subdomain_fallback' }
  return null
}

function toStringParams(params) {
  if (!params || typeof params !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    out[key] = String(value)
  }
  return out
}

/**
 * Resolve one request.
 *
 * @returns
 *   { type: 'root', site }
 *   | { type: 'redirect', status, location, linkId, via, site }
 *   | { type: 'not_found', reason, site }
 */
export async function resolveRequest(pool, request, cache) {
  const host = normalizeHost(request.host)
  const site = await lookupHost(pool, host, cache)

  if (!site) return { type: 'not_found', reason: 'unknown_host', site: null }
  // A subdomain switched off in the panel stops resolving links, but its root
  // still answers — see root.mjs. Turning a host off is not a reason to start
  // looking disposable to a malware scanner.
  if (!site.active || !site.domain_active) {
    return { type: 'not_found', reason: 'host_inactive', site }
  }

  const slug = slugFrom(request.pathname)
  if (!slug) return { type: 'root', site }

  const { rows } = await pool.query(LINK_SQL, [site.id, slug])
  const link = rows[0]

  if (!link) {
    const fallback = fallbackFor(null, site)
    if (fallback) return { type: 'redirect', status: 302, location: fallback.location, linkId: null, via: fallback.via, site }
    return { type: 'not_found', reason: 'unknown_slug', site }
  }

  const now = request.now ?? Date.now()

  // Expiry is checked before the active flag on purpose: expiry is the state
  // that has a fallback, and a link that is both paused and past its date is
  // past its date.
  if (link.expires_at && new Date(link.expires_at).getTime() <= now) {
    const fallback = fallbackFor(link, site)
    if (fallback) {
      return { type: 'redirect', status: 302, location: fallback.location, linkId: link.id, via: fallback.via, site }
    }
    return { type: 'not_found', reason: 'expired', site, linkId: link.id }
  }

  // A paused link has no fallback. Pausing is a deliberate "this must not
  // resolve", and quietly sending the visitor somewhere else would defeat it.
  if (!link.active) return { type: 'not_found', reason: 'inactive', site, linkId: link.id }

  let location
  try {
    location = buildTargetUrl(
      link.target_url,
      link,
      toStringParams(link.params),
      link.pass_through && request.search ? new URLSearchParams(request.search) : null
    )
  } catch {
    // Validation happens at write time, but a row edited by hand in psql has
    // never been through it. A destination that will not parse degrades to the
    // fallback instead of throwing a 500 at the visitor.
    const fallback = fallbackFor(link, site)
    if (fallback) {
      return { type: 'redirect', status: 302, location: fallback.location, linkId: link.id, via: fallback.via, site }
    }
    return { type: 'not_found', reason: 'bad_target', site, linkId: link.id }
  }

  return {
    type: 'redirect',
    // 302 is the default in the schema and the reason this product works.
    status: temporaryStatus(link.redirect_type),
    location,
    linkId: link.id,
    via: 'link',
    site,
  }
}
