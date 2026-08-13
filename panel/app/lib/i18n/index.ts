import { en } from './en.ts'
import { ptBR } from './pt-BR.ts'
import type { TranslationKey } from './en.ts'

export type { TranslationKey } from './en.ts'
export { en } from './en.ts'
export { ptBR } from './pt-BR.ts'

export type Locale = 'en' | 'pt-BR'

export const LOCALES: Locale[] = ['en', 'pt-BR']

const DEFAULT_LOCALE: Locale = 'en'

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = {
  en,
  'pt-BR': ptBR,
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as string[]).includes(value)
}

// A tag is matched case-insensitively, and a bare language matches its regional
// dictionary: with only two locales served, a visitor asking for 'pt-PT' is far
// better off reading Brazilian Portuguese than English.
function matchLocale(tag: string): Locale | null {
  const normalized = tag.trim().toLowerCase()
  if (normalized === '') return null

  const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized)
  if (exact) return exact

  const language = normalized.split('-')[0]
  return LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language) ?? null
}

const QUALITY = /^\s*q\s*=\s*(\d(?:\.\d{1,3})?)\s*$/i

function fromAcceptLanguage(header: string): Locale | null {
  const ranked: { tag: string; quality: number; order: number }[] = []

  header.split(',').forEach((part, order) => {
    const [rawTag, ...parameters] = part.split(';')
    const tag = rawTag.trim()
    if (tag === '') return

    let quality = 1
    for (const parameter of parameters) {
      const match = QUALITY.exec(parameter)
      // An unparseable q is ignored rather than treated as a refusal: a
      // malformed header should not silently cost the visitor their language.
      if (match) quality = Number(match[1])
    }

    // q=0 is an explicit "not this one", not a weak preference.
    if (quality > 0) ranked.push({ tag, quality, order })
  })

  // The order tie-break is spelled out instead of leaning on sort stability, so
  // an equal-quality header is decided by the order the client wrote it in.
  ranked.sort((a, b) => b.quality - a.quality || a.order - b.order)

  for (const { tag } of ranked) {
    // '*' means "anything", which is what the fallback is for.
    if (tag === '*') continue
    const locale = matchLocale(tag)
    if (locale) return locale
  }

  return null
}

export function resolveLocale(input: {
  userLocale?: string | null
  acceptLanguage?: string | null
  fallback?: Locale
}): Locale {
  // A stored preference that no longer names a locale we serve is treated as
  // absent rather than as a veto, so the browser still gets a say.
  const chosen = input.userLocale ? matchLocale(input.userLocale) : null
  if (chosen) return chosen

  const negotiated = input.acceptLanguage ? fromAcceptLanguage(input.acceptLanguage) : null
  if (negotiated) return negotiated

  const fallback = input.fallback ? matchLocale(input.fallback) : null
  return fallback ?? DEFAULT_LOCALE
}

const PLACEHOLDER = /\{(\w+)\}/g

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    // Object.hasOwn, not `in`: {constructor} or {toString} must render as
    // themselves rather than as something inherited from Object.prototype.
    Object.hasOwn(params, name) ? String(params[name]) : match
  )
}

function onMissingKey(key: string): string {
  // Written literally so bundlers can replace it at build time; the panel runs
  // this module on the server and in the browser.
  if (process.env.NODE_ENV === 'production') return key
  // Anywhere else — development, tests, an unset NODE_ENV — this is a bug that
  // should surface now rather than as a raw dotted key in someone's screenshot.
  throw new Error(`missing translation key: ${key}`)
}

export function t(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>
): string {
  // The locale can arrive from a database column or a cookie, so it is not
  // trusted to be one of the two we ship even though the type says so.
  const dictionary = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const template = dictionary[key]
  if (typeof template !== 'string') return onMissingKey(key)
  return params ? interpolate(template, params) : template
}
