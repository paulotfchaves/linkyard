import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { hashPassword } from '../app/lib/password.server.ts'
import { buildTargetUrl } from '../app/lib/links.server.ts'

// The dataset behind the public demo.
//
// A blank panel teaches nothing: the whole point of the demo is to show what
// this product looks like after three months of use, so the shape of the data
// matters as much as its existence. Every number here is invented, every host
// sits in a reserved domain, and nothing traces to a person.
//
// Two properties are load-bearing and both are covered by tests:
//   - it is idempotent, because the demo is reseeded on a schedule and a reseed
//     that doubled the history would compound into nonsense within a week;
//   - click_daily is derived from the events actually written, never made up
//     separately, because a rollup that disagrees with its source is the one
//     bug a demo cannot survive being caught in.

export const DEMO_PASSWORD = 'demo'

export type SeedCounts = {
  users: number
  domains: number
  subdomains: number
  links: number
  clicks: number
}

export type SeedOptions = {
  clicksDays?: number
}

// ── determinism ─────────────────────────────────────────────────────────────

const NAMESPACE = 'linkyard.demo.v1'

// Names, not random UUIDs: the same slug must resolve to the same row on every
// run, which is what lets the reseed be an upsert instead of a wipe.
function demoId(name: string): string {
  const digest = createHash('sha256').update(`${NAMESPACE}:${name}`).digest()
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

// A seeded generator, not Math.random: two runs must produce byte-identical
// traffic or the idempotency guarantee is only true of the rows we upsert.
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function weighted<T>(rand: () => number, items: readonly T[], weight: (item: T) => number): T {
  let threshold = rand() * items.reduce((sum, item) => sum + weight(item), 0)
  for (const item of items) {
    threshold -= weight(item)
    if (threshold <= 0) return item
  }
  return items[items.length - 1]
}

// ── the fictional account ───────────────────────────────────────────────────

// .example is reserved by RFC 2606: none of these can ever resolve, so no
// screenshot of the demo can send anyone to a site that belongs to someone.
const USERS = [
  {
    key: 'owner',
    username: 'owner',
    email: 'owner@example.com',
    role: 'owner',
    timezone: 'America/New_York',
    locale: 'en',
    lastSeenMinutesAgo: 4,
  },
  {
    key: 'editor',
    username: 'editor',
    email: 'editor@example.com',
    role: 'editor',
    timezone: 'Europe/Lisbon',
    locale: 'en',
    lastSeenMinutesAgo: 190,
  },
  {
    // Deliberately pt-BR: the panel ships bilingual and a demo where every
    // account speaks English never shows that half of the product.
    key: 'viewer',
    username: 'viewer',
    email: 'viewer@example.com',
    role: 'viewer',
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    lastSeenMinutesAgo: 1_500,
  },
] as const

const DOMAINS = [
  {
    key: 'harborline',
    apex: 'harborline.example',
    zone: 'demo-zone-harborline',
    account: 'demo-account',
    rootPolicy: 'branded_page',
    rootTarget: null,
  },
  {
    key: 'pinegrove',
    apex: 'pinegrove.example',
    zone: 'demo-zone-pinegrove',
    account: 'demo-account',
    rootPolicy: 'custom_url',
    rootTarget: 'https://www.pinegrove.example/',
  },
] as const

const SUBDOMAINS = [
  {
    key: 'go',
    domain: 'harborline',
    host: 'go.harborline.example',
    recordValue: 'edge.linkyard.example',
    cert: 'valid',
    health: 'ok',
    fallback: 'https://www.harborline.example/',
  },
  {
    key: 'try',
    domain: 'harborline',
    host: 'try.harborline.example',
    recordValue: 'edge.linkyard.example',
    cert: 'valid',
    // One unhealthy host on purpose: the health column is worth nothing in a
    // screenshot where every row is green.
    health: 'degraded',
    fallback: 'https://www.harborline.example/help',
  },
  {
    key: 'link',
    domain: 'pinegrove',
    host: 'link.pinegrove.example',
    recordValue: 'edge.linkyard.example',
    cert: 'valid',
    health: 'ok',
    fallback: 'https://www.pinegrove.example/',
  },
] as const

const TAGS = [
  {
    key: 'spring',
    name: 'Spring Campaign',
    kind: 'campaign',
    color: '#E4572E',
    description: 'Seasonal push across email and social',
  },
  {
    key: 'launch',
    name: 'Product Launch',
    kind: 'campaign',
    color: '#2E86AB',
    description: 'Everything pointing at the new release',
  },
  {
    key: 'newsletter',
    name: 'Newsletter',
    kind: 'evergreen',
    color: '#6A4C93',
    description: 'Links that live inside the weekly email',
  },
  {
    key: 'bio',
    name: 'Social Bio',
    kind: 'evergreen',
    color: '#1B998B',
    description: 'The handful of links in every profile',
  },
  {
    key: 'partner',
    name: 'Partner Referral',
    kind: 'campaign',
    color: '#F4A261',
    description: 'Outbound links shared with partners',
  },
] as const

type Tier = 'hero' | 'strong' | 'normal' | 'quiet'
type UserKey = (typeof USERS)[number]['key']
type SubdomainKey = (typeof SUBDOMAINS)[number]['key']
type TagKey = (typeof TAGS)[number]['key']

type LinkSpec = {
  slug: string
  sub: SubdomainKey
  tag: TagKey
  target: string
  tier: Tier
  owner?: UserKey
  pinned?: boolean
  redirect?: 301 | 302 | 307 | 308
  passThrough?: boolean
  params?: Record<string, string>
  utm?: {
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
    utm_content?: string
    utm_term?: string
  }
  note?: string
  fallback?: string
  pausedDaysAgo?: number
  expiresDaysAgo?: number
  bornWithLaunch?: boolean
}

const SPRING = { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'spring' }
const LAUNCH = { utm_source: 'launch', utm_medium: 'campaign', utm_campaign: 'launch' }
const SOCIAL = { utm_source: 'profile', utm_medium: 'social' }

const LINKS: readonly LinkSpec[] = [
  {
    slug: 'spring-sale',
    sub: 'go',
    tag: 'spring',
    target: 'https://www.harborline.example/collections/spring-sale',
    tier: 'hero',
    pinned: true,
    utm: SPRING,
    note: 'Main seasonal destination — kept pinned all quarter',
  },
  {
    slug: 'spring-lookbook',
    sub: 'go',
    tag: 'spring',
    target: 'https://www.harborline.example/journal/spring-lookbook',
    tier: 'strong',
    utm: SPRING,
  },
  {
    slug: 'spring-bundle',
    sub: 'go',
    tag: 'spring',
    target: 'https://www.harborline.example/collections/spring-bundle',
    tier: 'normal',
    utm: SPRING,
  },
  {
    slug: 'spring-vip',
    sub: 'try',
    tag: 'spring',
    target: 'https://www.harborline.example/vip/spring',
    tier: 'normal',
    utm: { ...SPRING, utm_content: 'vip' },
  },
  {
    slug: 'spring-preview',
    sub: 'go',
    tag: 'spring',
    target: 'https://www.harborline.example/collections/spring-preview',
    tier: 'quiet',
    utm: SPRING,
  },
  {
    slug: 'spring-final-hours',
    sub: 'go',
    tag: 'spring',
    target: 'https://www.harborline.example/collections/spring-sale',
    tier: 'normal',
    utm: { ...SPRING, utm_content: 'final-hours' },
    expiresDaysAgo: 16,
    note: 'Expired with the campaign — kept for the report',
  },
  {
    slug: 'spring-drop-two',
    sub: 'go',
    tag: 'spring',
    target: 'https://www.harborline.example/collections/spring-drop-2',
    tier: 'quiet',
    pausedDaysAgo: 23,
  },
  {
    slug: 'launch',
    sub: 'go',
    tag: 'launch',
    target: 'https://www.harborline.example/launch',
    tier: 'hero',
    pinned: true,
    utm: LAUNCH,
    bornWithLaunch: true,
    note: 'The one link printed on everything',
  },
  {
    slug: 'launch-waitlist',
    sub: 'go',
    tag: 'launch',
    target: 'https://www.harborline.example/launch/waitlist',
    tier: 'strong',
    utm: LAUNCH,
    bornWithLaunch: true,
  },
  {
    slug: 'launch-demo',
    sub: 'go',
    tag: 'launch',
    target: 'https://www.harborline.example/launch/demo',
    tier: 'strong',
    // 307 keeps the method: this destination is behind a form post.
    redirect: 307,
    utm: LAUNCH,
    bornWithLaunch: true,
  },
  {
    slug: 'launch-pricing',
    sub: 'go',
    tag: 'launch',
    target: 'https://www.harborline.example/pricing',
    tier: 'normal',
    utm: LAUNCH,
    bornWithLaunch: true,
  },
  {
    slug: 'launch-faq',
    sub: 'try',
    tag: 'launch',
    target: 'https://www.harborline.example/launch/faq',
    tier: 'quiet',
    bornWithLaunch: true,
  },
  {
    slug: 'launch-webinar',
    sub: 'go',
    tag: 'launch',
    target: 'https://www.harborline.example/events/launch-webinar',
    tier: 'normal',
    utm: { ...LAUNCH, utm_content: 'webinar' },
    bornWithLaunch: true,
    expiresDaysAgo: 9,
    note: 'The session is over; the link stays as evidence',
  },
  {
    slug: 'launch-press',
    sub: 'try',
    tag: 'launch',
    target: 'https://www.harborline.example/press/launch',
    tier: 'quiet',
    bornWithLaunch: true,
    owner: 'editor',
  },
  {
    slug: 'news-signup',
    sub: 'go',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter',
    tier: 'strong',
    utm: { utm_source: 'site', utm_medium: 'referral' },
  },
  {
    slug: 'news-archive',
    sub: 'try',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter/archive',
    tier: 'quiet',
    owner: 'editor',
  },
  {
    slug: 'news-welcome',
    sub: 'go',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter/welcome',
    tier: 'normal',
    owner: 'editor',
  },
  {
    slug: 'news-june',
    sub: 'go',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter/june',
    tier: 'quiet',
    owner: 'editor',
    pausedDaysAgo: 34,
  },
  {
    slug: 'news-july',
    sub: 'go',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter/july',
    tier: 'normal',
    owner: 'editor',
  },
  {
    slug: 'news-august',
    sub: 'go',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter/august',
    tier: 'normal',
    owner: 'editor',
  },
  {
    slug: 'news-referral',
    sub: 'try',
    tag: 'newsletter',
    target: 'https://www.harborline.example/newsletter/referral',
    tier: 'quiet',
    params: { ref: 'reader' },
  },
  {
    slug: 'bio',
    sub: 'go',
    tag: 'bio',
    target: 'https://www.harborline.example/',
    tier: 'hero',
    pinned: true,
    // Pass-through: the profile link carries whatever the platform appends.
    passThrough: true,
    utm: SOCIAL,
    note: 'The link in every profile — never change the slug',
  },
  {
    slug: 'bio-shop',
    sub: 'go',
    tag: 'bio',
    target: 'https://www.harborline.example/collections/all',
    tier: 'strong',
    utm: SOCIAL,
  },
  {
    slug: 'bio-journal',
    sub: 'go',
    tag: 'bio',
    target: 'https://www.harborline.example/journal',
    tier: 'normal',
    utm: SOCIAL,
  },
  {
    slug: 'bio-podcast',
    sub: 'go',
    tag: 'bio',
    target: 'https://www.harborline.example/podcast',
    tier: 'normal',
    utm: SOCIAL,
  },
  {
    slug: 'bio-video',
    sub: 'try',
    tag: 'bio',
    target: 'https://www.harborline.example/watch',
    tier: 'quiet',
    utm: SOCIAL,
  },
  {
    slug: 'bio-support',
    sub: 'go',
    tag: 'bio',
    target: 'https://www.harborline.example/help',
    tier: 'normal',
    fallback: 'https://www.harborline.example/',
  },
  {
    slug: 'bio-jobs',
    sub: 'try',
    tag: 'bio',
    target: 'https://www.harborline.example/careers',
    tier: 'quiet',
    owner: 'editor',
  },
  {
    slug: 'partner-atlas',
    sub: 'link',
    tag: 'partner',
    target: 'https://www.pinegrove.example/partners/atlas',
    tier: 'normal',
    passThrough: true,
    params: { aff: 'atlas' },
  },
  {
    slug: 'partner-orbit',
    sub: 'link',
    tag: 'partner',
    target: 'https://www.pinegrove.example/partners/orbit',
    tier: 'normal',
    params: { aff: 'orbit' },
  },
  {
    slug: 'partner-vela',
    sub: 'link',
    tag: 'partner',
    target: 'https://www.pinegrove.example/partners/vela',
    tier: 'quiet',
    params: { aff: 'vela' },
  },
  {
    slug: 'partner-nimbus',
    sub: 'link',
    tag: 'partner',
    target: 'https://www.pinegrove.example/partners/nimbus',
    tier: 'quiet',
    pausedDaysAgo: 11,
    note: 'Paused while the agreement is renegotiated',
  },
  {
    slug: 'ref-atlas',
    sub: 'link',
    tag: 'partner',
    target: 'https://www.pinegrove.example/offers/atlas',
    tier: 'quiet',
  },
  {
    slug: 'ref-orbit',
    sub: 'link',
    tag: 'partner',
    target: 'https://www.pinegrove.example/offers/orbit',
    tier: 'quiet',
  },
  {
    slug: 'pricing',
    sub: 'try',
    tag: 'launch',
    target: 'https://www.harborline.example/pricing',
    tier: 'strong',
  },
  {
    slug: 'guides',
    sub: 'try',
    tag: 'newsletter',
    target: 'https://www.harborline.example/guides',
    tier: 'normal',
  },
  {
    slug: 'help',
    sub: 'try',
    tag: 'bio',
    target: 'https://www.harborline.example/help/getting-started',
    tier: 'normal',
  },
  {
    slug: 'status',
    sub: 'try',
    tag: 'bio',
    target: 'https://www.harborline.example/status',
    tier: 'quiet',
  },
  {
    slug: 'try-free',
    sub: 'try',
    tag: 'launch',
    target: 'https://www.harborline.example/try',
    tier: 'strong',
    utm: { ...LAUNCH, utm_content: 'trial' },
  },
  {
    slug: 'spring-gift',
    sub: 'try',
    tag: 'spring',
    target: 'https://www.harborline.example/collections/spring-gift',
    tier: 'quiet',
    utm: SPRING,
    pausedDaysAgo: 5,
  },
]

// ── the traffic model ───────────────────────────────────────────────────────

// ASNs come from the RFC 5398 documentation range, so no row points at a real
// network operator.
const DOC_ASN_BASE = 64_496

type Place = readonly [region: string, city: string]
type Geo = { country: string; weight: number; language: string; places: readonly Place[] }

const GEO: readonly Geo[] = [
  {
    country: 'US',
    weight: 46,
    language: 'en-US',
    places: [
      ['California', 'San Francisco'],
      ['New York', 'New York'],
      ['Texas', 'Austin'],
      ['Illinois', 'Chicago'],
      ['Washington', 'Seattle'],
    ],
  },
  {
    country: 'GB',
    weight: 11,
    language: 'en-GB',
    places: [
      ['England', 'London'],
      ['Scotland', 'Glasgow'],
    ],
  },
  {
    country: 'CA',
    weight: 7,
    language: 'en-CA',
    places: [
      ['Ontario', 'Toronto'],
      ['British Columbia', 'Vancouver'],
    ],
  },
  {
    country: 'AU',
    weight: 5,
    language: 'en-AU',
    places: [
      ['New South Wales', 'Sydney'],
      ['Victoria', 'Melbourne'],
    ],
  },
  {
    country: 'DE',
    weight: 4.5,
    language: 'de-DE',
    places: [
      ['Berlin', 'Berlin'],
      ['Bavaria', 'Munich'],
    ],
  },
  {
    country: 'BR',
    weight: 4,
    language: 'pt-BR',
    places: [
      ['Sao Paulo', 'Sao Paulo'],
      ['Rio de Janeiro', 'Rio de Janeiro'],
    ],
  },
  {
    country: 'FR',
    weight: 3.5,
    language: 'fr-FR',
    places: [
      ['Ile-de-France', 'Paris'],
      ['Occitanie', 'Toulouse'],
    ],
  },
  { country: 'NL', weight: 3, language: 'nl-NL', places: [['North Holland', 'Amsterdam']] },
  {
    country: 'ES',
    weight: 2.5,
    language: 'es-ES',
    places: [
      ['Madrid', 'Madrid'],
      ['Catalonia', 'Barcelona'],
    ],
  },
  {
    country: 'IN',
    weight: 2.5,
    language: 'en-IN',
    places: [
      ['Maharashtra', 'Mumbai'],
      ['Karnataka', 'Bengaluru'],
    ],
  },
  { country: 'MX', weight: 2, language: 'es-MX', places: [['Mexico City', 'Mexico City']] },
  {
    country: 'PT',
    weight: 1.8,
    language: 'pt-PT',
    places: [
      ['Lisbon', 'Lisbon'],
      ['Porto', 'Porto']
    ],
  },
  { country: 'IE', weight: 1.5, language: 'en-IE', places: [['Leinster', 'Dublin']] },
  { country: 'SE', weight: 1.4, language: 'sv-SE', places: [['Stockholm', 'Stockholm']] },
  { country: 'JP', weight: 1.3, language: 'ja-JP', places: [['Tokyo', 'Tokyo']] },
  { country: 'ZA', weight: 1, language: 'en-ZA', places: [['Gauteng', 'Johannesburg']] },
  { country: 'PL', weight: 0.9, language: 'pl-PL', places: [['Masovia', 'Warsaw']] },
  { country: 'IT', weight: 0.9, language: 'it-IT', places: [['Lazio', 'Rome']] },
  { country: 'AR', weight: 0.8, language: 'es-AR', places: [['Buenos Aires', 'Buenos Aires']] },
  { country: 'NZ', weight: 0.5, language: 'en-NZ', places: [['Auckland', 'Auckland']] },
]

type Stack = { os: string; browser: string; weight: number }
type DeviceFamily = { device: string; weight: number; stacks: readonly Stack[] }

// Product names, unlike the fictional account, have to be real here: a device
// breakdown reading "Browser A / Browser B" would demo nothing.
const DEVICES: readonly DeviceFamily[] = [
  {
    device: 'mobile',
    weight: 62,
    stacks: [
      { os: 'iOS', browser: 'Safari', weight: 40 },
      { os: 'iOS', browser: 'Chrome', weight: 12 },
      { os: 'Android', browser: 'Chrome', weight: 40 },
      { os: 'Android', browser: 'Samsung Internet', weight: 8 },
    ],
  },
  {
    device: 'desktop',
    weight: 31,
    stacks: [
      { os: 'macOS', browser: 'Chrome', weight: 26 },
      { os: 'macOS', browser: 'Safari', weight: 14 },
      { os: 'Windows', browser: 'Chrome', weight: 34 },
      { os: 'Windows', browser: 'Edge', weight: 18 },
      { os: 'Linux', browser: 'Firefox', weight: 8 },
    ],
  },
  {
    device: 'tablet',
    weight: 7,
    stacks: [
      { os: 'iPadOS', browser: 'Safari', weight: 74 },
      { os: 'Android', browser: 'Chrome', weight: 26 },
    ],
  },
]

type Referrer = { host: string | null; path: string | null; weight: number }

const REFERRERS: readonly Referrer[] = [
  { host: null, path: null, weight: 44 },
  { host: 'social.example', path: '/feed', weight: 14 },
  { host: 'search.example', path: '/results', weight: 12 },
  { host: 'mail.example', path: '/message', weight: 9 },
  { host: 'www.harborline.example', path: '/journal', weight: 8 },
  { host: 'blog.pinegrove.example', path: '/posts/spring', weight: 5 },
  { host: 'forum.example', path: '/thread/812', weight: 4 },
  { host: 'news.example', path: '/story', weight: 3 },
  { host: 'partner.pinegrove.example', path: '/links', weight: 1 },
]

// The five preview fetchers that actually distort a link report. They are named
// because the panel's whole bot story is "we know which one this was".
const BOT_KINDS = [
  { kind: 'whatsapp', weight: 34 },
  { kind: 'facebook', weight: 25 },
  { kind: 'telegram', weight: 16 },
  { kind: 'slack', weight: 13 },
  { kind: 'discord', weight: 12 },
] as const

const BOT_SHARE = 0.12

const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, 4, 7, 11, 14, 16, 17, 18, 19, 20, 21, 22, 20, 18, 15, 12, 9, 6, 4,
] as const

const TIER_BASE: Record<Tier, number> = { hero: 40, strong: 15, normal: 4, quiet: 1.5 }

// Sunday-indexed, matching Date#getUTCDay.
export const WEEKDAY_FACTOR = [0.42, 1.05, 1.12, 1.08, 1, 0.9, 0.48] as const

/**
 * How much of the weekly rhythm survives a launch day.
 *
 * During the launch the campaign is what drives traffic, not the office week,
 * so the weekday factor is damped toward flat. Left undamped it cancels the
 * spike curve exactly when the curve is the point: a peak on a Monday (1.05)
 * followed by a Tuesday (1.12) gives 8 x 1.05 against 5 x 1.12 — a ratio of
 * 1.5, so the two tallest bars come out level and the chart reads as a step
 * change rather than an event. Which weekday the peak lands on depends on the
 * date the seed runs, so the demo looked right on most days and wrong on the
 * rest, with nothing in the data to explain why.
 *
 * Exported so the property can be checked for every weekday the peak can fall
 * on, rather than only the one today happens to produce.
 */
export function shapeWeekday(weekday: number, spike: number): number {
  return spike > 1 ? 1 + (weekday - 1) * 0.35 : weekday
}

// Relative to the launch day. The tail is what makes it read as an event rather
// than a data error.
const SPIKE_CURVE = new Map<number, number>([
  [-1, 3.2],
  [0, 8],
  [1, 5],
  [2, 2.6],
  [3, 1.6],
  [4, 1.2],
])

// ── helpers ─────────────────────────────────────────────────────────────────

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function addDays(ms: number, days: number): number {
  return ms + days * 86_400_000
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// Table and column names are literals from this file only — no caller value
// reaches the interpolated string, and every row value is a bound parameter.
async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  batchSize: number
): Promise<number> {
  for (let start = 0; start < rows.length; start += batchSize) {
    const chunk = rows.slice(start, start + batchSize)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value)
        return `$${params.length}`
      })
      return `(${placeholders.join(', ')})`
    })
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
      params
    )
  }
  return rows.length
}

type Bucket = {
  clicks: number
  bots: number
  visitors: Set<string>
  byCountry: Map<string, number>
  byDevice: Map<string, number>
  byReferrer: Map<string, number>
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function fromMap(map: Map<string, number>): string {
  return JSON.stringify(Object.fromEntries(map))
}

// ── the seed ────────────────────────────────────────────────────────────────

export async function seedDemo(pool: Pool, opts: SeedOptions = {}): Promise<SeedCounts> {
  const days = opts.clicksDays ?? 90
  if (!Number.isInteger(days) || days < 1) {
    throw new TypeError('clicksDays must be a positive integer')
  }

  // Hashing costs ~19 MiB and two passes; there is no reason to hold a
  // transaction open for it, and all three accounts share one password anyway.
  const passwordHash = await hashPassword(DEMO_PASSWORD)

  const now = new Date()
  const today = utcMidnight(now)
  const firstDay = addDays(today, -(days - 1))

  const userIds = new Map<string, string>(USERS.map((u) => [u.key, demoId(`user:${u.key}`)]))
  const domainIds = new Map<string, string>(DOMAINS.map((d) => [d.key, demoId(`domain:${d.key}`)]))
  const subIds = new Map<string, string>(SUBDOMAINS.map((s) => [s.key, demoId(`subdomain:${s.key}`)]))
  const tagIds = new Map<string, string>(TAGS.map((t) => [t.key, demoId(`tag:${t.key}`)]))
  const linkIds = LINKS.map((l) => demoId(`link:${l.sub}/${l.slug}`))

  // The launch is forced onto a weekday: a spike that lands on a Sunday reads as
  // a glitch, because it collides with the weekend trough it is meant to dwarf.
  let spikeDay = Math.round(days * (60 / 90))
  while (spikeDay > 0 && spikeDay < days) {
    const weekday = new Date(addDays(firstDay, spikeDay)).getUTCDay()
    if (weekday !== 0 && weekday !== 6) break
    spikeDay -= 1
  }

  // The transaction is opened by hand rather than through the panel's
  // transaction() helper, which owns a module-level pool built from
  // DATABASE_URL. A seed has to run against the pool it was handed: a throwaway
  // test schema, a demo instance, a laptop.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Partitions first: an event written before its partition exists lands in
    // the catch-all, which is exactly what the demo is meant to demonstrate not
    // happening. One month of padding on each side because the FROM/TO bounds
    // are read in the session's time zone, so a click in the first hours of the
    // earliest month can otherwise fall below that month's lower bound.
    const firstMonth = new Date(firstDay)
    const lastMonth = new Date(today)
    for (
      let cursor = Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() - 1, 1);
      cursor <= Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1);
      cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)
    ) {
      await client.query('SELECT ensure_click_partition($1::date)', [dayKey(cursor)])
    }

    await insertUsers(client, userIds, passwordHash, now)
    await insertDomains(client, domainIds, subIds, now)
    await insertTags(client, tagIds)
    await insertLinks(client, linkIds, subIds, tagIds, userIds, today, firstDay, days, spikeDay)

    // History is regenerated rather than merged: the events carry no natural
    // key, so upserting them is impossible and appending them would double the
    // chart on every reseed. Only demo links are touched.
    await client.query('DELETE FROM click_daily WHERE link_id = ANY($1::uuid[])', [linkIds])
    await client.query('DELETE FROM click_events WHERE link_id = ANY($1::uuid[])', [linkIds])

    const clicks = await insertHistory(client, linkIds, firstDay, days, spikeDay)

    await client.query('COMMIT')

    return {
      users: USERS.length,
      domains: DOMAINS.length,
      subdomains: SUBDOMAINS.length,
      links: LINKS.length,
      clicks,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function insertUsers(
  client: PoolClient,
  userIds: Map<string, string>,
  passwordHash: string,
  now: Date
): Promise<void> {
  const rows = USERS.map((user) => [
    userIds.get(user.key),
    user.username,
    user.email,
    passwordHash,
    user.role,
    user.timezone,
    user.locale,
    new Date(now.getTime() - user.lastSeenMinutesAgo * 60_000),
  ])

  for (const row of rows) {
    await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, timezone, locale, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username, email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
         timezone = EXCLUDED.timezone, locale = EXCLUDED.locale,
         last_seen_at = EXCLUDED.last_seen_at`,
      row
    )
  }
}

async function insertDomains(
  client: PoolClient,
  domainIds: Map<string, string>,
  subIds: Map<string, string>,
  now: Date
): Promise<void> {
  const verifiedAt = new Date(now.getTime() - 120 * 86_400_000)

  for (const domain of DOMAINS) {
    await client.query(
      `INSERT INTO domains (id, apex, dns_zone_id, provider_account, root_policy, root_target, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         apex = EXCLUDED.apex, dns_zone_id = EXCLUDED.dns_zone_id,
         provider_account = EXCLUDED.provider_account, root_policy = EXCLUDED.root_policy,
         root_target = EXCLUDED.root_target, verified_at = EXCLUDED.verified_at`,
      [
        domainIds.get(domain.key),
        domain.apex,
        domain.zone,
        domain.account,
        domain.rootPolicy,
        domain.rootTarget,
        verifiedAt,
      ]
    )
  }

  for (const sub of SUBDOMAINS) {
    await client.query(
      `INSERT INTO subdomains (id, domain_id, host, infra_host_id, record_type, record_value,
                               cert_status, fallback_url, health, last_checked_at)
       VALUES ($1, $2, $3, $4, 'CNAME', $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         host = EXCLUDED.host, record_value = EXCLUDED.record_value,
         cert_status = EXCLUDED.cert_status, fallback_url = EXCLUDED.fallback_url,
         health = EXCLUDED.health, last_checked_at = EXCLUDED.last_checked_at`,
      [
        subIds.get(sub.key),
        domainIds.get(sub.domain),
        sub.host,
        `demo-host-${sub.key}`,
        sub.recordValue,
        sub.cert,
        sub.fallback,
        sub.health,
        new Date(now.getTime() - 4 * 60_000),
      ]
    )
  }
}

async function insertTags(client: PoolClient, tagIds: Map<string, string>): Promise<void> {
  for (const tag of TAGS) {
    await client.query(
      `INSERT INTO tags (id, name, kind, description, color)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, kind = EXCLUDED.kind,
         description = EXCLUDED.description, color = EXCLUDED.color`,
      [tagIds.get(tag.key), tag.name, tag.kind, tag.description, tag.color]
    )
  }
}

// A link's life: the day it starts taking traffic and the day it stops. Paused
// and expired links keep the history they earned and stop there, which is what
// makes the "expired" filter in the panel show something worth looking at.
function lifespan(
  spec: LinkSpec,
  days: number,
  spikeDay: number
): { start: number; end: number } {
  const start = spec.bornWithLaunch ? Math.max(0, spikeDay - 12) : 0
  let end = days - 1
  if (spec.pausedDaysAgo !== undefined) end = Math.min(end, days - 1 - spec.pausedDaysAgo)
  if (spec.expiresDaysAgo !== undefined) end = Math.min(end, days - 1 - spec.expiresDaysAgo)
  // end may fall before start on a short window, and must stay there: a click
  // recorded after the link expired is the report contradicting itself.
  return { start, end }
}

async function insertLinks(
  client: PoolClient,
  linkIds: readonly string[],
  subIds: Map<string, string>,
  tagIds: Map<string, string>,
  userIds: Map<string, string>,
  today: number,
  firstDay: number,
  days: number,
  spikeDay: number
): Promise<void> {
  for (const [index, spec] of LINKS.entries()) {
    const { start } = lifespan(spec, days, spikeDay)
    // Created a little before its first click, never after: a link with traffic
    // predating its own creation date is the kind of detail that makes a demo
    // stop being believable.
    const createdAt = new Date(addDays(firstDay, start) - (start === 0 ? 9 : 3) * 86_400_000)

    await client.query(
      `INSERT INTO links (id, subdomain_id, slug, target_url, redirect_type,
                          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                          params, pass_through, is_pinned, expires_at, fallback_url,
                          tag_id, note, active, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15,
               $16, $17, $18, $19, $20)
       ON CONFLICT (id) DO UPDATE SET
         subdomain_id = EXCLUDED.subdomain_id, slug = EXCLUDED.slug,
         target_url = EXCLUDED.target_url, redirect_type = EXCLUDED.redirect_type,
         utm_source = EXCLUDED.utm_source, utm_medium = EXCLUDED.utm_medium,
         utm_campaign = EXCLUDED.utm_campaign, utm_content = EXCLUDED.utm_content,
         utm_term = EXCLUDED.utm_term, params = EXCLUDED.params,
         pass_through = EXCLUDED.pass_through, is_pinned = EXCLUDED.is_pinned,
         expires_at = EXCLUDED.expires_at, fallback_url = EXCLUDED.fallback_url,
         tag_id = EXCLUDED.tag_id, note = EXCLUDED.note, active = EXCLUDED.active,
         created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
      [
        linkIds[index],
        subIds.get(spec.sub),
        spec.slug,
        spec.target,
        spec.redirect ?? 302,
        spec.utm?.utm_source ?? null,
        spec.utm?.utm_medium ?? null,
        spec.utm?.utm_campaign ?? null,
        spec.utm?.utm_content ?? null,
        spec.utm?.utm_term ?? null,
        JSON.stringify(spec.params ?? {}),
        spec.passThrough ?? false,
        spec.pinned ?? false,
        spec.expiresDaysAgo === undefined
          ? null
          : new Date(addDays(today, -spec.expiresDaysAgo) + 20 * 3_600_000),
        spec.fallback ?? null,
        tagIds.get(spec.tag),
        spec.note ?? null,
        spec.pausedDaysAgo === undefined,
        userIds.get(spec.owner ?? 'owner'),
        createdAt,
      ]
    )
  }
}

const EVENT_COLUMNS = [
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
] as const

const DAILY_COLUMNS = [
  'link_id',
  'day',
  'clicks',
  'uniques',
  'bot_clicks',
  'by_country',
  'by_device',
  'by_referrer',
] as const

const HOURS = HOUR_WEIGHTS.map((weight, hour) => ({ hour, weight }))
const ASN_BY_COUNTRY = new Map(GEO.map((geo, i) => [geo.country, DOC_ASN_BASE + (i % 16)]))

function digest(parts: string): Buffer {
  return createHash('sha256').update(`${NAMESPACE}:${parts}`).digest()
}

async function insertHistory(
  client: PoolClient,
  linkIds: readonly string[],
  firstDay: number,
  days: number,
  spikeDay: number
): Promise<number> {
  const rand = rng(0x5eed_1a4d)
  const events: unknown[][] = []
  const daily: unknown[][] = []
  let written = 0

  for (const [index, spec] of LINKS.entries()) {
    const linkId = linkIds[index]
    const { start, end } = lifespan(spec, days, spikeDay)
    const base = TIER_BASE[spec.tier]
    // What the edge would actually send the visitor to, composed by the same
    // function the edge uses — a demo whose final_url disagrees with the
    // product's own rule is a demo of something else.
    const finalUrl = buildTargetUrl(spec.target, spec.utm ?? {}, spec.params ?? {})

    for (let day = start; day <= end; day++) {
      const dayStart = addDays(firstDay, day)
      const trend = 0.8 + (0.5 * day) / Math.max(1, days - 1)
      const spike = SPIKE_CURVE.get(day - spikeDay) ?? 1
      // The launch days carry no noise: the spike is the one thing the demo
      // chart has to say, and day-to-day jitter on top of an 8x multiplier is
      // what turns a deliberate 8x into an accidental 5x or 13x.
      const jitter = spike > 1 ? 1 : 0.72 + rand() * 0.62

      const shaped = shapeWeekday(WEEKDAY_FACTOR[new Date(dayStart).getUTCDay()], spike)

      const total = Math.round(base * shaped * trend * spike * jitter)
      if (total <= 0) continue

      // Fewer visitors than clicks, because people open the same link twice.
      const audience = Math.max(1, Math.round(total * 0.8))
      const bucket: Bucket = {
        clicks: 0,
        bots: 0,
        visitors: new Set<string>(),
        byCountry: new Map(),
        byDevice: new Map(),
        byReferrer: new Map(),
      }

      for (let i = 0; i < total; i++) {
        const isBot = rand() < BOT_SHARE
        const geo = weighted(rand, GEO, (g) => g.weight)
        const place = geo.places[Math.floor(rand() * geo.places.length)]
        const hour = weighted(rand, HOURS, (h) => h.weight).hour
        const occurredAt = new Date(dayStart + hour * 3_600_000 + Math.floor(rand() * 3_600_000))
        const visitor = Math.floor(rand() * audience)

        if (isBot) {
          const bot = weighted(rand, BOT_KINDS, (b) => b.weight)
          bucket.bots += 1
          events.push([
            linkId,
            occurredAt,
            digest(`bot:${index}:${day}:${visitor}`),
            geo.country,
            null,
            null,
            ASN_BY_COUNTRY.get(geo.country) ?? DOC_ASN_BASE,
            // A preview fetcher is not a device, an OS, or a browser. Filling
            // those columns is how bot traffic ends up inside a device report.
            null,
            null,
            null,
            null,
            null,
            null,
            true,
            bot.kind,
            finalUrl,
            18 + Math.floor(rand() * 40),
          ])
          continue
        }

        const family = weighted(rand, DEVICES, (d) => d.weight)
        const stack = weighted(rand, family.stacks, (s) => s.weight)
        const referrer = weighted(rand, REFERRERS, (r) => r.weight)
        const ipHash = digest(`visitor:${index}:${visitor}`)

        bucket.clicks += 1
        bucket.visitors.add(ipHash.toString('hex'))
        bump(bucket.byCountry, geo.country)
        bump(bucket.byDevice, family.device)
        bump(bucket.byReferrer, referrer.host ?? 'direct')

        events.push([
          linkId,
          occurredAt,
          ipHash,
          geo.country,
          place[0],
          place[1],
          ASN_BY_COUNTRY.get(geo.country) ?? DOC_ASN_BASE,
          family.device,
          stack.os,
          stack.browser,
          geo.language,
          referrer.host,
          referrer.host ? `https://${referrer.host}${referrer.path ?? '/'}` : null,
          false,
          null,
          finalUrl,
          32 + Math.floor(rand() * 150),
        ])
      }

      daily.push([
        linkId,
        dayKey(dayStart),
        bucket.clicks,
        bucket.visitors.size,
        bucket.bots,
        fromMap(bucket.byCountry),
        fromMap(bucket.byDevice),
        fromMap(bucket.byReferrer),
      ])

      // Flushed as we go: 90 days of every link held at once is a large enough
      // array to matter on the small instance the demo runs on.
      if (events.length >= 4_000) {
        written += await insertRows(client, 'click_events', EVENT_COLUMNS, events, 400)
        events.length = 0
      }
    }
  }

  written += await insertRows(client, 'click_events', EVENT_COLUMNS, events, 400)
  await insertRows(client, 'click_daily', DAILY_COLUMNS, daily, 300)
  return written
}
