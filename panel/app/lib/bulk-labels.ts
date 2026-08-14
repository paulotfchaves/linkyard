import { t, type Locale } from './i18n/index.ts'
import { en } from './i18n/en.ts'

// Every bulk and schedule string, resolved once and handed to the client
// components as data. The components never import the dictionary themselves, so
// they stay renderable in isolation and the locale is decided server-side.
const PREFIXES = ['bulk.', 'schedule.', 'editor.utm.', 'editor.tag.', 'editor.destination.', 'table.']

export function bulkLabels(locale: Locale): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(en)) {
    if (PREFIXES.some((p) => key.startsWith(p))) out[key] = t(locale, key as never)
  }
  return out
}
