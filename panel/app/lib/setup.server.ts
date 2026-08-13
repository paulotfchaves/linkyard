import { timingSafeEqual } from 'node:crypto'
import { queryOne } from './db.server.ts'
import { hashPassword } from './password.server.ts'
import { createSession } from './session.server.ts'
import { isLocale, type Locale } from './i18n/index.ts'

/**
 * First run: claiming the installation.
 *
 * Two gates, and the second is the one that matters. The panel's hostname is
 * published to public Certificate Transparency logs within seconds of the
 * certificate being issued — before the operator has finished reading the
 * "your panel is ready" screen. Anyone streaming certstream for freshly logged
 * hostnames can reach an open /setup first and claim the account, on the
 * operator's own domain and at their expense.
 *
 * So the route requires a SETUP_TOKEN that only the deploy knows, and stops
 * existing the moment a user exists.
 */

export async function isClaimed(): Promise<boolean> {
  const row = await queryOne<{ any: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS any')
  return row?.any ?? false
}

export function setupTokenMatches(candidate: string | null): boolean {
  const expected = process.env.SETUP_TOKEN
  // No token configured means setup is closed, not open. Failing shut is the
  // only safe default for a route that hands over the whole installation.
  if (!expected || !candidate) return false

  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type SetupInput = {
  username: string
  email: string
  password: string
  timezone: string
  locale: string
}

export type SetupProblem =
  | 'already_claimed'
  | 'bad_token'
  | 'username'
  | 'email'
  | 'password'
  | 'timezone'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,40}$/

export function validateSetup(input: SetupInput): SetupProblem | null {
  if (!USERNAME_RE.test(input.username.trim())) return 'username'
  if (!EMAIL_RE.test(input.email.trim())) return 'email'
  // Length over composition rules: a long passphrase beats a short string with
  // a symbol bolted on, and composition rules mostly teach people to write
  // Password1!.
  if (input.password.length < 12 || input.password.length > 200) return 'password'
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone })
  } catch {
    return 'timezone'
  }
  return null
}

export async function claimInstallation(
  input: SetupInput,
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ token: string; expiresAt: Date }> {
  if (await isClaimed()) throw new Error('already claimed')

  const locale: Locale = isLocale(input.locale) ? input.locale : 'en'
  const passwordHash = await hashPassword(input.password)

  const user = await queryOne<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role, timezone, locale)
     VALUES ($1, $2, $3, 'owner', $4, $5)
     RETURNING id`,
    [input.username.trim(), input.email.trim(), passwordHash, input.timezone, locale]
  )
  if (!user) throw new Error('owner could not be created')

  return createSession(user.id, meta)
}
