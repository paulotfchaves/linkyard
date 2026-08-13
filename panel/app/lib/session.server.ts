import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { query, queryOne } from './db.server.ts'

/**
 * The __Host- prefix is not decoration here — it is the fix for an attack this
 * product invites by design.
 *
 * Linkyard exists to create subdomains under the operator's apex. Any of those
 * hosts, or an XSS on any of them, could otherwise issue
 * `Set-Cookie: linkyard_session=<attacker token>; Domain=.example.com`, and the
 * browser would send both cookies with the panel's own. The victim signs in and
 * silently lands in the attacker's account — where everything they then do,
 * including pasting a Cloudflare token into the provisioning flow, belongs to
 * the attacker.
 *
 * Browsers refuse a __Host- cookie that carries a Domain attribute at all, so
 * no sibling host can plant one. It requires Secure unconditionally, which is
 * safe in development too: browsers treat http://localhost as a secure context.
 */
export const SESSION_COOKIE = '__Host-linkyard_session'

// Two clocks, both enforced on every resolve. The idle clock keeps an abandoned
// laptop from staying signed in; the absolute clock puts a hard ceiling on how
// long a stolen cookie can be kept alive by simply using it.
export const IDLE_TIMEOUT_DAYS = 7
export const ABSOLUTE_TIMEOUT_DAYS = 30

// 256 bits, base64url so the value needs no cookie escaping on either side.
const TOKEN_BYTES = 32

export type SessionUser = {
  id: string
  username: string
  email: string
  role: 'owner' | 'admin' | 'editor' | 'viewer'
  timezone: string
  locale: string
  sessionId: string
  /** The row's sliding expiry, so a caller can re-issue the cookie to match it. */
  expiresAt: Date
}

type ResolvedRow = {
  session_id: string
  expires_at: Date
  token_hash: string
  id: string
  username: string
  email: string
  role: SessionUser['role']
  timezone: string
  locale: string
}

// SHA-256 rather than a password hash: the token is 256 bits of machine
// randomness, so there is no guessable input to slow an attacker down over, and
// a KDF would only add latency to every authenticated request. What this buys
// is that a database dump — or a leaked backup — yields digests that cannot be
// replayed as cookies.
//
// It also decides how the lookup works: the digest is matched by an indexed
// equality test inside Postgres, so the raw token is never compared to a stored
// value in this process and there is no string comparison to time.
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// The ip column is inet and the value comes from a proxy header, which can hold
// anything a client cares to send. An unparseable address is dropped rather
// than rejected: losing one audit field is a smaller failure than refusing a
// legitimate sign-in.
function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const candidate = ip.trim()
  return isIP(candidate) === 0 ? null : candidate
}

// Values are used verbatim, without percent-decoding: the token is base64url,
// which is already cookie-safe, and decoding would let a crafted cookie resolve
// to a different string than the one the browser stored.
/**
 * Returns the cookie only when it appears exactly once.
 *
 * Taking the first match would let a duplicate decide the answer, and cookie
 * ordering is creation-time, not something the server controls. Belt and braces
 * with the __Host- prefix: a duplicate that somehow arrives is a failed auth
 * rather than a silent choice between two identities.
 */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  let found: string | null = null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    if (found !== null) return null
    const value = part.slice(separator + 1).trim()
    found = value.length > 0 ? value : null
    if (found === null) return null
  }
  return found
}

// NODE_ENV is read per call, not captured at import: one build serves dev and
// production, and a caller that changes the environment has to see the change.
//
// SameSite=Lax, not Strict: the panel is reached by following links from mail
// and from provider redirects, and Strict would drop the session on exactly
// those top-level navigations while adding nothing against cross-site form
// posts, which Lax already blocks.
// Secure is unconditional, and Domain is deliberately absent: both are required
// for a browser to accept a __Host- cookie at all. Development is unaffected,
// since http://localhost counts as a secure context.
function cookieFlags(): string {
  return 'Path=/; HttpOnly; SameSite=Lax; Secure'
}

export function sessionCookieHeader(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${token}; ${cookieFlags()}; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}`
}

export function clearedCookieHeader(): string {
  return `${SESSION_COOKIE}=; ${cookieFlags()}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  // Postgres computes the expiry so the row and the cookie cannot disagree, and
  // so a container with a skewed clock cannot mint a session that outlives the
  // policy.
  const row = await queryOne<{ expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))
     RETURNING expires_at`,
    [userId, tokenDigest(token), normalizeIp(meta.ip), meta.userAgent ?? null, IDLE_TIMEOUT_DAYS]
  )
  if (!row) throw new Error('session could not be created')

  return { token, expiresAt: row.expires_at }
}

export async function resolveSession(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!token) return null

  // Check and slide in one statement. Splitting it into a SELECT then an UPDATE
  // would open a window where a revoke lands between the two, and would let two
  // concurrent requests write the sliding expiry from different snapshots.
  //
  // LEAST() is where the two clocks meet: the idle window moves forward on use,
  // but never past the absolute ceiling. The ceiling is also tested in the WHERE
  // clause, because the row's stored expires_at was written by an earlier
  // resolve and can still sit in the future when the ceiling has already passed
  // — capping it on the way out would grant one last request through the door.
  const row = await queryOne<ResolvedRow>(
    `UPDATE sessions s
        SET expires_at = LEAST(
              now() + make_interval(days => $2::int),
              s.created_at + make_interval(days => $3::int)
            )
       FROM users u
      WHERE u.id = s.user_id
        AND s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.created_at + make_interval(days => $3::int) > now()
        AND u.status = 'active'
    RETURNING s.id AS session_id, s.expires_at, s.token_hash,
              u.id, u.username, u.email, u.role, u.timezone, u.locale`,
    [tokenDigest(token), IDLE_TIMEOUT_DAYS, ABSOLUTE_TIMEOUT_DAYS]
  )
  if (!row) return null

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    timezone: row.timezone,
    locale: row.locale,
    sessionId: row.session_id,
    expiresAt: new Date(row.expires_at),
  }
}

/**
 * The cookie has to slide with the row, or the idle window is a lie.
 *
 * The row's expiry moves forward on every resolve, but the browser holds the
 * Max-Age it was given at sign-in. Without re-issuing, somebody active every
 * single day is signed out on day 7 and the 30-day ceiling is unreachable —
 * dead code documenting a limit no session can approach.
 *
 * Re-issue only once the stored expiry has drifted materially, so an ordinary
 * page load does not carry a Set-Cookie header it does not need.
 */
const REISSUE_AFTER_MS = 60 * 60 * 1000

export function refreshedCookieHeader(
  request: Request,
  user: SessionUser
): string | null {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!token) return null

  const cookieExpiry = Date.now() + IDLE_TIMEOUT_DAYS * 86_400_000
  if (Math.abs(user.expiresAt.getTime() - cookieExpiry) < REISSUE_AFTER_MS) return null

  return sessionCookieHeader(token, user.expiresAt)
}

export async function revokeSession(request: Request): Promise<void> {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!token) return

  // Stamped, not deleted: the row is the record that this session existed and
  // when it ended, which is what an operator needs after an account is
  // compromised. Retention prunes it later.
  await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    tokenDigest(token),
  ])
}
