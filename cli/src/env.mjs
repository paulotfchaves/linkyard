// Composing the .env a Docker Compose install runs on.
//
// The whole job is to produce values that are right the first time, because
// every one of these is a value an operator would otherwise invent by hand —
// and the ones invented by hand are the ones that turn up as "changeme" in a
// deployed installation.

import { randomBytes } from 'node:crypto'

// Long enough that the vault's own floor is never the binding constraint, and
// hex so it survives a shell, a YAML file and a copy-paste without quoting.
const SECRET_BYTES = 32

export function generateSecret(bytes = SECRET_BYTES) {
  return randomBytes(bytes).toString('hex')
}

/**
 * Refuse a value that is a placeholder rather than a secret.
 *
 * This is the same rule the vault enforces at runtime, applied here so the
 * failure lands while the operator is still at the keyboard. It exists because
 * `${{secret(64)}}` — a function that only runs on a Railway *template* deploy
 * — once reached configuration verbatim and became the encryption key for
 * every installation that shipped it.
 */
export function assertRealSecret(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  if (value.includes('${{') || value.includes('}}')) {
    throw new Error(`${name} looks like an unresolved template placeholder, not a secret`)
  }
  if (/^(changeme|placeholder|secret|password|todo)$/i.test(value.trim())) {
    throw new Error(`${name} is a placeholder, not a secret`)
  }
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters`)
  }
  return value
}

const LABEL = /^_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The same host rule the Cloudflare module applies, so both installers agree. */
export function assertHost(name, host) {
  const normalized = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (normalized === '') throw new Error(`${name} is required`)
  const labels = normalized.split('.')
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new Error(`${name} is not a valid hostname: ${normalized}`)
  }
  return normalized
}

export function assertEmail(name, value) {
  const email = String(value ?? '').trim()
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,20}$/.test(email)) {
    throw new Error(`${name} is not a valid email address`)
  }
  return email
}

/**
 * Build the file.
 *
 * Values are quoted unconditionally. A generated secret can begin with a
 * character the shell reads as syntax, and an unquoted one silently truncates
 * — producing an installation that starts, works, and cannot decrypt anything
 * written by the installation before it.
 */
export function composeEnv(values) {
  const lines = [
    '# Written by `npx linkyard install`. Treat this file as a credential store:',
    '# it holds the key every Cloudflare token in the database is encrypted with.',
    '',
  ]
  for (const [key, value] of Object.entries(values)) {
    lines.push(`${key}=${JSON.stringify(String(value))}`)
  }
  return lines.join('\n') + '\n'
}

export function buildInstall({ panelHost, redirectApex, acmeEmail, cloudflareToken = '' }) {
  const host = assertHost('LINKYARD_PANEL_HOST', panelHost)
  const apex = assertHost('LINKYARD_REDIRECT_APEX', redirectApex)
  const email = assertEmail('ACME_EMAIL', acmeEmail)

  if (host === apex) {
    throw new Error('the panel host and the redirect apex must differ, or the panel shadows every short link')
  }

  return {
    POSTGRES_USER: 'linkyard',
    POSTGRES_PASSWORD: generateSecret(24),
    POSTGRES_DB: 'linkyard',
    ENCRYPTION_KEY: assertRealSecret('ENCRYPTION_KEY', generateSecret()),
    IP_HASH_SALT: assertRealSecret('IP_HASH_SALT', generateSecret()),
    SETUP_TOKEN: assertRealSecret('SETUP_TOKEN', generateSecret()),
    PANEL_ORIGIN: `https://${host}`,
    INFRA_PROVIDER: 'compose',
    ACME_EMAIL: email,
    CLOUDFLARE_API_TOKEN: cloudflareToken,
    LINKYARD_PANEL_HOST: host,
    LINKYARD_REDIRECT_APEX: apex,
  }
}
