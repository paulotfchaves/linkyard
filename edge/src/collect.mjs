// Click collection: everything that happens after the visitor is already gone.
//
// Two rules govern this file. Nothing here runs before the response is sent — a
// lost metric is acceptable, a slow redirect is not. And no raw IP address ever
// reaches the database: an address is personal data under the LGPD and the GDPR,
// and the two things the product wants from one — telling two visitors apart and
// naming a country — are both had without keeping it. The first is an HMAC. The
// second is a lookup whose input is dropped on the way into the queue.

import { createHmac, randomBytes } from 'node:crypto'
import { geoFromEnv } from './geo.mjs'

// One geolocation handle for the process, opened the first time a collector
// needs one. A second copy would mean a second 60 MB database in memory and a
// second weekly download of the same file. Without the MaxMind variables this
// costs nothing: the handle answers null and schedules no work.
let sharedGeo = null
function defaultGeo() {
  sharedGeo ??= geoFromEnv()
  return sharedGeo
}

/**
 * The salt that makes the hash unlinkable to anyone holding a database dump.
 *
 * With no salt configured the process invents one rather than storing addresses
 * in the clear. The cost is that unique-visitor counts restart with the
 * process; the alternative is a table of personal data nobody agreed to.
 */
export function resolveIpSalt(
  // IP_HASH_SALT is the name every install path actually sets — Compose, the
  // Railway template and .env.example alike. Reading a different name meant no
  // deployment ever supplied a salt, so every process invented its own: unique
  // counts reset on each restart, and two replicas turned one visitor into two.
  explicit = process.env.IP_HASH_SALT ?? process.env.CLICK_IP_SALT
) {
  const salt = typeof explicit === 'string' ? explicit.trim() : ''
  if (salt) return salt

  // In production this is not a warning, it is a misconfiguration that quietly
  // corrupts every unique count. Failing at boot is louder than a log line
  // nobody reads inside a container.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('IP_HASH_SALT is required in production: unique counts are meaningless without it')
  }

  console.warn('IP_HASH_SALT is not set: using a per-process salt, unique counts reset on restart')
  return randomBytes(32).toString('hex')
}

/**
 * The visitor's address, counted from the trusted end of the chain.
 *
 * X-Forwarded-For is appended to, not prepended: the proxy in front of this
 * service writes the address it saw at the END of the list. Reading the
 * leftmost entry reads whatever the client chose to send, so anyone could make
 * one visit look like a hundred unique visitors, or collapse all traffic into
 * one bucket — in a product whose whole purpose is a click report somebody can
 * trust. It also decides the country once geo lookup lands on this value.
 *
 * TRUSTED_PROXY_HOPS says how many proxies sit in front. One is right for both
 * install targets (Caddy on a VPS, Railway's edge); a stack that adds a CDN in
 * front sets two.
 */
export function clientIp(req, { trustProxy = true, hops = trustedHops() } = {}) {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for']
    const header = Array.isArray(raw) ? raw.join(',') : raw
    const entries = (header ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)

    if (entries.length) {
      // Count from the right: index 0 hops back is the address our own proxy
      // wrote. Anything further left is client-supplied and unverifiable.
      const index = Math.max(0, entries.length - Math.max(1, hops))
      return normalizeIp(entries[index])
    }
  }
  return normalizeIp(req.socket?.remoteAddress ?? '')
}

function trustedHops() {
  const raw = Number(process.env.TRUSTED_PROXY_HOPS ?? '1')
  return Number.isInteger(raw) && raw > 0 ? raw : 1
}

function normalizeIp(value) {
  const ip = String(value).trim()
  if (!ip) return ''
  // Node reports IPv4 clients on a dual-stack socket in the v4-mapped form, so
  // the same visitor would otherwise hash into two buckets depending on which
  // listener answered.
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  if (ip.startsWith('[') && ip.includes(']')) return ip.slice(1, ip.indexOf(']'))
  return ip
}

/** @returns {Buffer|null} 32 bytes, or null when there is no address to hash. */
export function hashIp(ip, salt) {
  if (!ip) return null
  return createHmac('sha256', salt).update(ip).digest()
}

// Order matters twice over: Edge, Opera and Samsung all claim to be Chrome, and
// Chrome on iOS claims to be Safari. First match wins.
const BROWSERS = [
  ['Edge', /\bEdg(?:e|A|iOS)?\//i],
  ['Opera', /\bOPR\/|\bOpera\//i],
  ['Samsung Internet', /SamsungBrowser\//i],
  ['Firefox', /\bFirefox\/|\bFxiOS\//i],
  ['Chrome', /\bChrome\/|\bCriOS\//i],
  ['Safari', /\bSafari\//i],
]

const OSES = [
  // iPhone before macOS: an iOS User-Agent contains the words "like Mac OS X".
  ['iOS', /iPhone|iPad|iPod|iOS/i],
  ['Android', /Android/i],
  ['Windows', /Windows NT/i],
  ['Chrome OS', /CrOS/i],
  ['macOS', /Macintosh|Mac OS X/i],
  ['Linux', /Linux|X11/i],
]

/**
 * Device, OS and browser, from the User-Agent alone.
 *
 * Deliberately coarse and dependency-free: the panel reports "mobile vs
 * desktop, iOS vs Android, Chrome vs Safari", and a 2 MB User-Agent database
 * on the critical path would buy version numbers nobody asked for.
 */
export function parseUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  if (!ua) return { device: null, os: null, browser: null }

  let device = 'desktop'
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    device = 'tablet'
  } else if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua)) {
    device = 'mobile'
  }

  const os = OSES.find(([, re]) => re.test(ua))?.[0] ?? null
  const browser = BROWSERS.find(([, re]) => re.test(ua))?.[0] ?? null
  return { device, os, browser }
}

const LANGUAGE_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/

/** The visitor's first declared language tag, or null. Quality values are dropped. */
export function parseLanguage(header) {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') return null
  const tag = value.split(',')[0]?.split(';')[0]?.trim()
  if (!tag || tag === '*' || !LANGUAGE_RE.test(tag)) return null
  return tag
}

/** The referrer's host. The full value is kept separately; this is what reports group by. */
export function referrerHost(referer) {
  const value = Array.isArray(referer) ? referer[0] : referer
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value.trim()).host.toLowerCase() || null
  } catch {
    return null
  }
}

const COLUMNS = [
  'link_id',
  'occurred_at',
  'ip_hash',
  'country',
  'region',
  'city',
  'asn',
  'device',
  'os',
  'browser',
  'language',
  'referrer_host',
  'referrer_full',
  'is_bot',
  'bot_kind',
  'final_url',
  'latency_ms',
]

// The four geo columns stay null until an installation configures MaxMind, and
// the panel already reads them as optional. Nothing else about a click changes.

function rowValues(event) {
  return [
    event.linkId,
    event.occurredAt ?? new Date(),
    event.ipHash ?? null,
    event.country ?? null,
    event.region ?? null,
    event.city ?? null,
    Number.isInteger(event.asn) ? event.asn : null,
    event.device ?? null,
    event.os ?? null,
    event.browser ?? null,
    event.language ?? null,
    event.referrerHost ?? null,
    event.referrerFull ? String(event.referrerFull).slice(0, 500) : null,
    event.isBot === true,
    event.botKind ?? null,
    event.finalUrl ? String(event.finalUrl).slice(0, 2000) : null,
    Number.isFinite(event.latencyMs) ? Math.round(event.latencyMs) : null,
  ]
}

/**
 * An in-memory buffer that writes click_events in batches.
 *
 * A transaction per click means one round trip per redirect on a service whose
 * whole job is to answer in under 50ms, and a burst of traffic — the only time
 * the numbers matter — is exactly when that cost lands. Batching by size or by
 * 250ms, whichever comes first, keeps a quiet link's clicks visible within a
 * blink and a busy one's cheap.
 *
 * A failed batch is dropped and counted, never retried into a growing queue: a
 * database that is refusing writes must not also become the reason the process
 * runs out of memory, and no click is worth a redirect.
 *
 * An event may carry `ip`, the visitor's address as `clientIp` returned it. It
 * is the one field that is not stored: record() turns it into a country, region,
 * city and ASN and drops it before the event is queued. Omitting it is not an
 * error — the four columns stay null, which is also what happens on every
 * installation without a MaxMind licence key.
 */
export function createCollector({
  pool,
  flushMs = 250,
  maxBatch = 100,
  maxInFlight = 20,
  geo = defaultGeo(),
} = {}) {
  let queue = []
  let timer = null
  // Flushes are chained rather than concurrent so two overlapping batches
  // cannot interleave into one oversized statement.
  let inFlight = Promise.resolve()
  let dropped = 0
  let stopped = false
  // The chain needs a depth limit, not just a failure path. A write that
  // REJECTS is already handled; a write that never settles — the ordinary shape
  // of a partition or a lock wait — leaves each pending link holding a full
  // batch while the queue keeps accepting more. Measured: 500k events against a
  // hung database grew the heap by 399 MB while both counters read zero,
  // because nothing had errored and the queue was emptied on every flush.
  let inFlightBatches = 0

  async function writeBatch(batch) {
    const params = []
    const tuples = batch.map((event) => {
      const values = rowValues(event)
      const placeholders = values.map((_, i) => `$${params.length + i + 1}`)
      params.push(...values)
      return `(${placeholders.join(',')})`
    })

    await pool.query(
      `INSERT INTO click_events (${COLUMNS.join(', ')}) VALUES ${tuples.join(',')}`,
      params
    )
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!queue.length) return inFlight

    const batch = queue
    queue = []

    if (inFlightBatches >= maxInFlight) {
      dropped += batch.length
      console.error(
        `click batch dropped (${batch.length} events, ${dropped} total): ` +
          `${inFlightBatches} batches already awaiting a database that is not answering`
      )
      return inFlight
    }

    inFlightBatches += 1
    inFlight = inFlight.then(async () => {
      try {
        await writeBatch(batch)
      } catch (err) {
        dropped += batch.length
        console.error(`click batch dropped (${batch.length} events, ${dropped} total):`, err.message)
      } finally {
        inFlightBatches -= 1
      }
    })
    return inFlight
  }

  /**
   * Turns `event.ip` into a place and drops the address.
   *
   * This is where the lookup belongs and the only place it happens. record() is
   * called with the response already on the wire, so reading the database
   * cannot delay a redirect — and the raw address never reaches the queue,
   * which is held in memory for up to 250ms and then handed to a database.
   * Neither is a place for a value the product promised not to keep.
   */
  function place(event) {
    if (!event.ip) return event
    const { ip, ...rest } = event
    let found = null
    try {
      found = geo.lookup(ip)
    } catch (err) {
      // A soft dependency in every failure mode, including the one where the
      // lookup itself is broken. The click is worth more than the column.
      console.error('geo lookup failed:', err?.message ?? err)
    }
    return found ? { ...rest, ...found } : rest
  }

  return {
    record(event) {
      if (stopped || !event?.linkId) return
      queue.push(place(event))
      if (queue.length >= maxBatch) {
        flush()
        return
      }
      if (!timer) {
        timer = setTimeout(flush, flushMs)
        // The buffer must never be the reason the process stays alive.
        timer.unref?.()
      }
    },
    flush,
    async stop() {
      stopped = true
      await flush()
      await inFlight
    },
    get pending() {
      // Queued AND in flight. Reporting only the queue said "nothing pending"
      // while twenty batches sat waiting on a hung database — the one number an
      // operator would look at, lying at the exact moment it mattered.
      return queue.length + inFlightBatches * maxBatch
    },
    get dropped() {
      return dropped
    },
  }
}
