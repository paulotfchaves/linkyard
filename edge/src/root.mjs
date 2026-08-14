// The surfaces that keep a redirect domain off a blocklist.
//
// A domain whose root answers 404, whose favicon 404s and which has no
// robots.txt reads as disposable infrastructure to the scanners WhatsApp and
// Meta run over shared links — and a blocked domain ends every campaign on it
// at once. None of these responses serve a visitor directly; they exist so the
// domain looks like a place, not a throwaway.
//
// Everything here is a pure function of its arguments so it can be read and
// tested without a socket.

/**
 * The Host header is written by whoever sends the request. Reflecting it into
 * HTML unescaped turns every domain this product serves into a reflected-XSS
 * endpoint on demand.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
 * What the root of a host should answer.
 *
 * The subdomain's policy wins over its domain's, and every branch degrades
 * rather than failing: a subdomain overriding to custom_url without a target
 * falls through to the domain's target, then to the apex, then to the branded
 * page. There is no path out of this function that produces a 404, which is the
 * entire point of the root_policy column having no "404" member.
 *
 * @returns {{ type: 'redirect', location: string } | { type: 'page' }}
 */
export function rootDecision(site) {
  if (!site) return { type: 'page' }

  const apex = absoluteUrl(site.apex ? `https://${site.apex}/` : null)
  const policy = site.sub_root_policy ?? site.domain_root_policy

  if (policy === 'branded_page') return { type: 'page' }

  if (policy === 'custom_url') {
    const target =
      absoluteUrl(site.sub_root_policy ? site.sub_root_target : null) ??
      absoluteUrl(site.domain_root_target) ??
      apex
    return target ? { type: 'redirect', location: target } : { type: 'page' }
  }

  // redirect_apex, and anything unrecognised a future migration might add.
  return apex ? { type: 'redirect', location: apex } : { type: 'page' }
}

/**
 * Headers every single response carries.
 *
 * `no-referrer` so the destination never learns which short link sent the
 * visitor — that is the operator's data, not the destination's. `nosniff`
 * because the branded pages and the favicon are the only bodies this service
 * emits and neither should ever be re-typed by a browser. There is no
 * X-Powered-By to remove: node:http does not add one, and this service does not
 * run Express, which does.
 */
export function securityHeaders({ https = false } = {}) {
  const headers = {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
  // Only over TLS. Sent on a plain-http origin the header is ignored, and on a
  // developer's http://localhost it would pin a host they cannot un-pin.
  // No includeSubDomains: this service is authoritative for one host, not for
  // whatever else the operator runs under the same apex.
  if (https) headers['Strict-Transport-Security'] = 'max-age=31536000'
  return headers
}

export function robotsTxt() {
  // The slug space is disallowed because a short link is a private address in a
  // campaign, not a page: indexing it leaks the campaign and pollutes the click
  // report with crawler traffic. The root is explicitly allowed so the domain
  // is still a crawlable, ordinary place.
  return [
    'User-agent: *',
    'Allow: /$',
    'Allow: /robots.txt',
    'Allow: /favicon.ico',
    'Disallow: /',
    '',
  ].join('\n')
}

// An SVG rather than a binary .ico: the requirement is a 200 and a recognisable
// mark, every browser of the last decade renders an SVG favicon, and an ICO
// would mean a base64 blob nobody can review in a diff.
export const FAVICON = {
  contentType: 'image/svg+xml',
  body:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Linkyard">' +
    '<rect width="32" height="32" rx="7" fill="#0f0c0a"/>' +
    '<rect x="9" y="9" width="14" height="14" rx="2" transform="rotate(45 16 16)" fill="#f0460e"/>' +
    '</svg>',
}

/**
 * RFC 9116. `Expires` is mandatory — a security.txt without it is invalid, and
 * every scanner that reads the file says so — so it is computed per request
 * rather than pinned at build time.
 */
export function securityTxt(contact, { now = new Date() } = {}) {
  const value = typeof contact === 'string' ? contact.trim() : ''
  // Omitted rather than served hollow: a security.txt with no contact is a
  // promise of a channel that does not exist.
  if (!value) return null

  const normalized = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `mailto:${value}`
  const expires = new Date(now.getTime() + 365 * 24 * 3_600_000).toISOString()
  return [`Contact: ${normalized}`, `Expires: ${expires}`, 'Preferred-Languages: en, pt-BR', ''].join('\n')
}

// Threshold surfaces, in the words of DESIGN.md: an ember panel means the
// product is speaking. Everything is inline and self-contained — a redirect
// domain that fetches a font or a script from somewhere else hands a third
// party the traffic log the product exists to keep, and the Ephesis script word
// is skipped here because shipping a font file to the edge would do exactly
// that or bloat the image for one glyph.
const PAGE_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#0f0c0a;color:#fefefe;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
display:flex;align-items:center;justify-content:center;padding:clamp(.625rem,1.2vw,1rem);letter-spacing:-.01em}
main{width:100%;max-width:34rem;background:#1d1d1d;border-radius:clamp(1rem,2vw,1.75rem);padding:clamp(1.75rem,5vw,3rem)}
.host{display:flex;align-items:center;gap:.5rem;font-size:.6875rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
color:rgba(255,255,255,.78);margin:0 0 1.5rem;word-break:break-all}
.glyph{flex:none;width:7px;height:7px;border-radius:2px;background:#f0460e;transform:rotate(45deg)}
h1{margin:0 0 .75rem;font-size:clamp(1.75rem,4.4vw,2.5rem);font-weight:600;line-height:1.06;letter-spacing:-.04em}
p{margin:0;font-size:1rem;line-height:1.6;color:rgba(255,255,255,.78)}
a{display:inline-block;margin-top:1.75rem;padding:.5625rem 1.125rem;border-radius:999px;background:#f0460e;color:#fff;
font-size:.875rem;font-weight:600;text-decoration:none}
a span{display:inline-block;margin-left:.375rem;transition:transform .25s}
a:hover span{transform:translate(.1875rem,-.1875rem)}
@media(prefers-reduced-motion:reduce){a span{transition:none}}
`.trim()

function page({ host, title, heading, lede, apex }) {
  const link = apex
    ? `<a href="https://${escapeHtml(apex)}/">Go to ${escapeHtml(apex)} <span>&#8599;</span></a>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head><body><main>
<p class="host"><span class="glyph"></span>${escapeHtml(host)}</p>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(lede)}</p>
${link}
</main></body></html>
`
}

/** The 404. Branded HTML, never a text/plain "Not found". */
export function notFoundPage(host, apex = null) {
  return page({
    host,
    apex,
    title: `Link not found · ${host}`,
    heading: 'This link is not here.',
    lede: 'The address may have been mistyped, or the campaign behind it has ended.',
  })
}

/** The root under `branded_page`, and the root of any host this install does not know. */
export function rootPage(host, apex = null) {
  return page({
    host,
    apex,
    title: host,
    heading: 'Short links live here.',
    lede: 'This address serves short links for a campaign. Follow the link you were given.',
  })
}
