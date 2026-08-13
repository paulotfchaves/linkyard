// Link rules that hold everywhere: in the panel's browser code, in its server
// code, and in the edge resolver.
//
// This file must never import a server module. It is imported by client
// components, and a `pg` import reaching the browser bundle is both a build
// failure and a sign the rule moved to the wrong side of the wire.

// Link rules: slug validation, destination composition, and the checks that
// keep a link from being born broken.
//
// The composition half is pure and lives at the top so it can be tested without
// a database — it is the part with actual rules, and the part the edge service
// must agree with byte for byte.

export const UTM_KEYS = [
  'utm_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const

export type UtmKey = (typeof UTM_KEYS)[number]
export type Utms = Partial<Record<UtmKey, string | null>>

// Served by the edge itself. A link here would be unreachable, and losing the
// robots/favicon responses is part of what makes a redirect domain look
// disposable to malware scanners.
export const RESERVED_SLUGS = new Set([
  'health',
  'robots.txt',
  'favicon.ico',
  'sitemap.xml',
  '_status',
  '_linkyard',
])

const SLUG_RE = /^[A-Za-z0-9._~-]{1,120}$/

export type SlugProblem = 'empty' | 'format' | 'reserved' | 'well_known'

export function validateSlug(raw: string): SlugProblem | null {
  const slug = raw.trim()
  if (!slug) return 'empty'
  if (!SLUG_RE.test(slug)) return 'format'
  const lower = slug.toLowerCase()
  if (RESERVED_SLUGS.has(lower)) return 'reserved'
  if (lower.startsWith('.well-known')) return 'well_known'
  return null
}

export type UrlProblem = 'empty' | 'invalid' | 'scheme'

export function validateTargetUrl(raw: string): UrlProblem | null {
  const value = raw.trim()
  if (!value) return 'empty'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'invalid'
  }
  // Only http(s). A javascript: or data: destination would turn every short
  // link into a script-injection vector for whoever clicks it.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme'
  return null
}

// A destination pointing back at this installation makes a loop that burns a
// browser's redirect budget and reports as a broken link.
export function detectsLoop(targetUrl: string, knownHosts: string[]): boolean {
  let host: string
  try {
    host = new URL(targetUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return knownHosts.some((h) => h.toLowerCase() === host)
}

/**
 * Compose the final destination: base URL + UTMs + custom parameters.
 *
 * Precedence, and the reason for it: a parameter already written into the
 * destination by the person who pasted it wins over the link's stored fields.
 * They typed it last and more specifically, so overwriting it would silently
 * discard an intent the UI never showed them.
 */
export function buildTargetUrl(
  targetUrl: string,
  utms: Utms,
  params: Record<string, string> = {},
  passThrough?: URLSearchParams | null
): string {
  const url = new URL(targetUrl)
  const existing = url.searchParams

  for (const key of UTM_KEYS) {
    const value = utms[key]
    if (value && !existing.has(key)) existing.set(key, value)
  }

  for (const [key, value] of Object.entries(params)) {
    if (value && !existing.has(key)) existing.set(key, value)
  }

  // Pass-through carries the query string the visitor arrived with. It fills
  // gaps only — never overwrites what the link itself declared.
  if (passThrough) {
    for (const [key, value] of passThrough.entries()) {
      if (!existing.has(key)) existing.set(key, value)
    }
  }

  return url.toString()
}

/**
 * Split a pasted URL into a clean destination plus the UTMs it carried.
 *
 * Ported from the panel this product abstracts, where it earned its place:
 * people paste a URL that already has tracking on it, and typing the same
 * values twice into six fields is how a campaign gets mislabelled.
 */
export function splitUtmsFromUrl(raw: string): { base: string; utms: Utms } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  const utms: Utms = {}
  const keep = new URLSearchParams()
  let found = false

  url.searchParams.forEach((value, key) => {
    if ((UTM_KEYS as readonly string[]).includes(key)) {
      utms[key as UtmKey] = value
      found = true
    } else {
      keep.set(key, value)
    }
  })

  if (!found) return null

  const qs = keep.toString()
  url.search = qs ? `?${qs}` : ''
  return { base: url.toString(), utms }
}

export type LinkStatus = 'active' | 'paused' | 'scheduled' | 'expired'

export function linkStatus(link: {
  active: boolean
  expires_at: Date | string | null
  scheduled?: boolean
}): LinkStatus {
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) return 'expired'
  if (!link.active) return 'paused'
  if (link.scheduled) return 'scheduled'
  return 'active'
}


export type LinkInput = {
  subdomainId: string
  slug: string
  targetUrl: string
  redirectType?: number
  utms?: Utms
  params?: Record<string, string>
  passThrough?: boolean
  isPinned?: boolean
  expiresAt?: Date | null
  fallbackUrl?: string | null
  tagId?: string | null
  note?: string | null
  active?: boolean
}

