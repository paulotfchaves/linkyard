import { t, type Locale } from './i18n/index.ts'
import { query } from './db.server.ts'
import {
  UTM_KEYS,
  validateSlug,
  validateTargetUrl,
  detectsLoop,
  type LinkInput,
  type Utms,
} from './links.server.ts'

// Shared by the create and edit routes so a rule cannot drift between them:
// validating on one path and not the other is how a bad row gets in.

export function navFor(locale: Locale) {
  return [
    { to: '/links', label: t(locale, 'nav.links') },
    { to: '/domains', label: t(locale, 'nav.domains') },
    { to: '/analytics', label: t(locale, 'nav.analytics') },
    { to: '/members', label: t(locale, 'nav.members') },
  ]
}

export function editorLabels(locale: Locale): Record<string, string> {
  return {
    destinationSection: t(locale, 'editor.section.destination'),
    trackingSection: t(locale, 'editor.section.tracking'),
    behaviorSection: t(locale, 'editor.section.behavior'),
    domain: t(locale, 'editor.domain.label'),
    slug: t(locale, 'editor.slug.label'),
    slugHint: t(locale, 'editor.slug.hint'),
    destination: t(locale, 'editor.destination.label'),
    destinationPlaceholder: t(locale, 'editor.destination.placeholder'),
    utm_source: t(locale, 'editor.utm.source'),
    utm_medium: t(locale, 'editor.utm.medium'),
    utm_campaign: t(locale, 'editor.utm.campaign'),
    utm_content: t(locale, 'editor.utm.content'),
    utm_term: t(locale, 'editor.utm.term'),
    utm_id: t(locale, 'editor.utm.id'),
    paramsTitle: t(locale, 'editor.params.title'),
    paramsAdd: t(locale, 'editor.params.add'),
    paramKey: t(locale, 'editor.params.key'),
    paramValue: t(locale, 'editor.params.value'),
    paramRemove: t(locale, 'editor.params.remove'),
    tag: t(locale, 'editor.tag.label'),
    tagNone: t(locale, 'editor.tag.none'),
    expiry: t(locale, 'editor.expiry.label'),
    expiryHint: t(locale, 'editor.expiry.hint'),
    fallback: t(locale, 'editor.fallback.label'),
    fallbackHint: t(locale, 'editor.fallback.hint'),
    note: t(locale, 'editor.note.label'),
    pinned: t(locale, 'table.pinned'),
    cancel: t(locale, 'common.cancel'),
  }
}

export type ParseResult = { input: LinkInput } | { errors: Record<string, string> }

export async function parseLinkForm(request: Request, locale: Locale): Promise<ParseResult> {
  const form = await request.formData()
  const errors: Record<string, string> = {}

  const subdomainId = String(form.get('subdomainId') ?? '')
  const slug = String(form.get('slug') ?? '').trim()
  const targetUrl = String(form.get('targetUrl') ?? '').trim()

  const slugProblem = validateSlug(slug)
  if (slugProblem === 'empty') errors.slug = t(locale, 'validation.slug.required')
  else if (slugProblem === 'format') errors.slug = t(locale, 'validation.slug.format')
  else if (slugProblem) errors.slug = t(locale, 'validation.slug.reserved')

  const urlProblem = validateTargetUrl(targetUrl)
  if (urlProblem === 'empty') errors.targetUrl = t(locale, 'validation.url.required')
  else if (urlProblem === 'invalid') errors.targetUrl = t(locale, 'validation.url.invalid')
  else if (urlProblem === 'scheme') errors.targetUrl = t(locale, 'validation.url.scheme')

  // A destination pointing at any host this installation serves would bounce the
  // visitor between two of our own links until the browser gives up.
  if (!errors.targetUrl) {
    const hosts = await query<{ host: string }>('SELECT host FROM subdomains')
    if (detectsLoop(targetUrl, hosts.map((h) => h.host))) {
      errors.targetUrl = t(locale, 'validation.url.loop')
    }
  }

  const utms: Utms = {}
  for (const key of UTM_KEYS) {
    const value = String(form.get(key) ?? '').trim()
    if (value) utms[key] = value
  }

  let params: Record<string, string> = {}
  try {
    const raw = JSON.parse(String(form.get('params') ?? '[]')) as Array<{
      key: string
      value: string
    }>
    for (const entry of raw) {
      const key = entry.key?.trim()
      if (!key) continue
      if (key in params) {
        errors.params = t(locale, 'validation.params.duplicate')
        break
      }
      params[key] = entry.value ?? ''
    }
  } catch {
    params = {}
  }

  const expiresRaw = String(form.get('expiresAt') ?? '').trim()
  let expiresAt: Date | null = null
  if (expiresRaw) {
    const parsed = new Date(expiresRaw)
    if (Number.isNaN(parsed.getTime())) errors.expiresAt = t(locale, 'validation.expiry.past')
    else if (parsed.getTime() <= Date.now()) errors.expiresAt = t(locale, 'validation.expiry.past')
    else expiresAt = parsed
  }

  if (Object.keys(errors).length > 0) return { errors }

  return {
    input: {
      subdomainId,
      slug,
      targetUrl,
      utms,
      params,
      isPinned: form.get('isPinned') === 'on',
      expiresAt,
      fallbackUrl: String(form.get('fallbackUrl') ?? '').trim() || null,
      tagId: String(form.get('tagId') ?? '') || null,
      note: String(form.get('note') ?? '').trim() || null,
    },
  }
}
