import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCALES, isLocale, resolveLocale, t } from '../app/lib/i18n/index.ts'
import type { Locale, TranslationKey } from '../app/lib/i18n/index.ts'
import { en } from '../app/lib/i18n/en.ts'
import { ptBR } from '../app/lib/i18n/pt-BR.ts'

const PLACEHOLDER = /\{(\w+)\}/g

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]).sort()
}

function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.NODE_ENV
  if (value === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
}

// ---------------------------------------------------------------- key parity

test('both dictionaries expose identical key sets', () => {
  const english = Object.keys(en).sort()
  const portuguese = Object.keys(ptBR).sort()

  const missingInPortuguese = english.filter((key) => !(key in ptBR))
  const missingInEnglish = portuguese.filter((key) => !(key in en))

  assert.deepEqual(missingInPortuguese, [], 'keys present in en but absent from pt-BR')
  assert.deepEqual(missingInEnglish, [], 'keys present in pt-BR but absent from en')
  assert.deepEqual(portuguese, english)
})

test('the dictionary is large enough to cover the panel', () => {
  assert.ok(Object.keys(en).length >= 80, `expected at least 80 keys, got ${Object.keys(en).length}`)
})

test('every value is a non-empty trimmed string', () => {
  for (const [key, value] of [...Object.entries(en), ...Object.entries(ptBR)]) {
    assert.equal(typeof value, 'string', `${key} is not a string`)
    assert.notEqual(value.trim(), '', `${key} is empty`)
    assert.equal(value, value.trim(), `${key} has surrounding whitespace`)
  }
})

test('a translated string carries the same placeholders as its English source', () => {
  // A translator dropping {slug} produces a sentence that silently loses the
  // only piece of information the user needed.
  for (const key of Object.keys(en) as TranslationKey[]) {
    assert.deepEqual(
      placeholdersOf(ptBR[key]),
      placeholdersOf(en[key]),
      `placeholder mismatch on ${key}`
    )
  }
})

test('every key resolves in every locale', () => {
  for (const locale of LOCALES) {
    for (const key of Object.keys(en) as TranslationKey[]) {
      const value = t(locale, key)
      assert.equal(typeof value, 'string')
      assert.notEqual(value, key, `${key} fell through to the raw key in ${locale}`)
    }
  }
})

// -------------------------------------------------- type-level key parity

// Runtime parity is a safety net; the contract is that a missing key fails the
// BUILD. These cases compile the two dictionaries in isolation to prove the
// annotation on pt-BR.ts is doing that work — including a deliberately broken
// copy, so a passing control run cannot be mistaken for a vacuous test.
const TSC = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url))
const I18N_DIR = fileURLToPath(new URL('../app/lib/i18n/', import.meta.url))
const REMOVED_KEY = 'links.status.paused'

function typecheck(ptBRSource: string): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'linkyard-i18n-'))
  try {
    writeFileSync(join(dir, 'en.ts'), readFileSync(join(I18N_DIR, 'en.ts')))
    writeFileSync(join(dir, 'pt-BR.ts'), ptBRSource)
    const result = spawnSync(
      TSC,
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target', 'es2022',
        '--module', 'esnext',
        '--moduleResolution', 'bundler',
        'en.ts',
        'pt-BR.ts',
      ],
      { cwd: dir, encoding: 'utf8' }
    )
    return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the dictionaries compile as written', () => {
  const source = readFileSync(join(I18N_DIR, 'pt-BR.ts'), 'utf8')
  const { code, output } = typecheck(source)
  assert.equal(code, 0, output)
})

test('a key missing from pt-BR is a compile error', () => {
  const source = readFileSync(join(I18N_DIR, 'pt-BR.ts'), 'utf8')
  const broken = source.replace(new RegExp(`^\\s*'${REMOVED_KEY}':.*\\n`, 'm'), '')
  assert.notEqual(broken, source, `fixture key ${REMOVED_KEY} was not found in pt-BR.ts`)

  const { code, output } = typecheck(broken)
  assert.notEqual(code, 0, 'tsc accepted a dictionary with a missing key')
  assert.match(output, new RegExp(REMOVED_KEY))
})

test('a key unknown to en is a compile error in pt-BR', () => {
  const source = readFileSync(join(I18N_DIR, 'pt-BR.ts'), 'utf8')
  const broken = source.replace(
    new RegExp(`^(\\s*)'${REMOVED_KEY}':`, 'm'),
    `$1'links.status.invented': 'Inventado',\n$1'${REMOVED_KEY}':`
  )
  assert.notEqual(broken, source)

  const { code, output } = typecheck(broken)
  assert.notEqual(code, 0, 'tsc accepted a dictionary with an unknown key')
  assert.match(output, /links\.status\.invented/)
})

// -------------------------------------------------------------- interpolation

test('interpolation replaces a named placeholder', () => {
  assert.equal(t('en', 'setup.password.hint', { min: 12 }), 'At least 12 characters.')
  assert.equal(t('pt-BR', 'setup.password.hint', { min: 12 }), 'No mínimo 12 caracteres.')
})

test('interpolation accepts strings and numbers', () => {
  assert.equal(t('en', 'account.signedInAs', { name: 'ana' }), 'Signed in as ana')
  assert.equal(t('en', 'signIn.error.throttled', { minutes: 5 }), 'Too many attempts. Try again in 5 min.')
})

test('a missing param leaves the placeholder visible instead of printing undefined', () => {
  const value = t('en', 'links.delete.title', {})
  assert.equal(value, 'Delete {slug}?')
  assert.ok(!value.includes('undefined'))

  const noParams = t('en', 'links.delete.title')
  assert.equal(noParams, 'Delete {slug}?')
})

test('a template with several placeholders fills the ones it was given', () => {
  assert.equal(
    t('en', 'validation.slug.duplicate', { slug: 'promo' }),
    '"promo" is already in use on {host}.'
  )
  assert.equal(
    t('en', 'validation.slug.duplicate', { slug: 'promo', host: 'go.example.com' }),
    '"promo" is already in use on go.example.com.'
  )
})

test('an inherited property is not treated as a param', () => {
  // Object.hasOwn, not `in`: {constructor} must not resolve to a function body.
  const value = t('en', 'links.delete.title', Object.create({ slug: 'leaked' }) as Record<string, string>)
  assert.equal(value, 'Delete {slug}?')
})

// ------------------------------------------------------------ locale resolving

test('an explicit user locale beats Accept-Language', () => {
  assert.equal(resolveLocale({ userLocale: 'en', acceptLanguage: 'pt-BR,pt;q=0.9' }), 'en')
  assert.equal(resolveLocale({ userLocale: 'pt-BR', acceptLanguage: 'en-US,en;q=0.9' }), 'pt-BR')
})

test('Accept-Language q-values are parsed and ranked', () => {
  assert.equal(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: 'en;q=0.8,pt-BR;q=0.9' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: 'en-US,pt-BR;q=0.9' }), 'en')
  assert.equal(resolveLocale({ acceptLanguage: 'de;q=1.0, pt;q=0.5, en;q=0.7' }), 'en')
})

test('an equal-quality header is decided by its own order', () => {
  assert.equal(resolveLocale({ acceptLanguage: 'pt-BR,en' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: 'en,pt-BR' }), 'en')
})

test('q=0 is a refusal, not a weak preference', () => {
  assert.equal(resolveLocale({ acceptLanguage: 'pt-BR;q=0,en;q=0.1' }), 'en')
  assert.equal(resolveLocale({ acceptLanguage: 'pt-BR;q=0', fallback: 'pt-BR' }), 'pt-BR')
})

test('a bare language matches its regional dictionary', () => {
  assert.equal(resolveLocale({ userLocale: 'pt' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: 'pt-PT' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: 'en-GB,en;q=0.9' }), 'en')
})

test('locale matching ignores case and surrounding space', () => {
  assert.equal(resolveLocale({ userLocale: 'PT-br' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: ' PT-BR , en;q=0.8 ' }), 'pt-BR')
})

test('the wildcard is left to the fallback', () => {
  assert.equal(resolveLocale({ acceptLanguage: '*', fallback: 'pt-BR' }), 'pt-BR')
})

test('an unsupported preference falls through to the fallback, then to English', () => {
  assert.equal(resolveLocale({ acceptLanguage: 'fr-FR,de;q=0.8', fallback: 'pt-BR' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: 'fr-FR,de;q=0.8' }), 'en')
  assert.equal(resolveLocale({}), 'en')
  assert.equal(resolveLocale({ userLocale: null, acceptLanguage: null }), 'en')
  assert.equal(resolveLocale({ userLocale: '', acceptLanguage: '' }), 'en')
})

test('an unusable user locale does not swallow the header', () => {
  // The stored value can be stale or hand-edited; it must not veto a header
  // that does name a locale we serve.
  assert.equal(resolveLocale({ userLocale: 'xx', acceptLanguage: 'pt-BR' }), 'pt-BR')
  assert.equal(resolveLocale({ userLocale: 'xx', fallback: 'pt-BR' }), 'pt-BR')
})

test('an unusable fallback is treated as absent', () => {
  assert.equal(resolveLocale({ fallback: 'xx' as Locale }), 'en')
})

test('a malformed header does not throw', () => {
  assert.equal(resolveLocale({ acceptLanguage: ',,;q=,pt-BR;q=zzz' }), 'pt-BR')
  assert.equal(resolveLocale({ acceptLanguage: ';;;' }), 'en')
})

test('LOCALES lists exactly the dictionaries that exist', () => {
  assert.deepEqual([...LOCALES].sort(), ['en', 'pt-BR'])
  assert.equal(isLocale('pt-BR'), true)
  assert.equal(isLocale('pt'), false)
  assert.equal(isLocale(null), false)
})

// --------------------------------------------------------------- unknown keys

test('an unknown key returns the key itself in production', () => {
  withNodeEnv('production', () => {
    assert.equal(t('en', 'no.such.key' as TranslationKey), 'no.such.key')
  })
})

test('an unknown key throws in development', () => {
  withNodeEnv('development', () => {
    assert.throws(() => t('en', 'no.such.key' as TranslationKey), /no\.such\.key/)
  })
})

test('an unset NODE_ENV fails loudly rather than silently', () => {
  withNodeEnv(undefined, () => {
    assert.throws(() => t('en', 'no.such.key' as TranslationKey), /no\.such\.key/)
  })
})

test('an unsupported locale still renders English rather than failing', () => {
  withNodeEnv('production', () => {
    assert.equal(t('fr' as Locale, 'links.title'), en['links.title'])
  })
})
