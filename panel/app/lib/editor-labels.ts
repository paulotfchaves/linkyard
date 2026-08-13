import { t, type Locale } from './i18n/index.ts'

// Label lookups the route components render, so they must stay free of any
// server import: the same file is bundled for the browser.

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

