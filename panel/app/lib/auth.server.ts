import { redirect } from 'react-router'
import { resolveSession, refreshedCookieHeader, type SessionUser } from './session.server.ts'
import { resolveLocale, type Locale } from './i18n/index.ts'

// The one door into an authenticated route.
//
// Every loader and action calls this rather than reading the session itself, so
// there is exactly one place where "is this person signed in" is answered, and
// a route that forgets to ask has no user object to work with at all.

export type Session = {
  user: SessionUser
  locale: Locale
  /** Set-Cookie value when the sliding expiry moved enough to be worth re-issuing. */
  refresh: string | null
}

export async function getSession(request: Request): Promise<Session | null> {
  const user = await resolveSession(request)
  if (!user) return null

  return {
    user,
    locale: resolveLocale({
      userLocale: user.locale,
      acceptLanguage: request.headers.get('accept-language'),
    }),
    refresh: refreshedCookieHeader(request, user),
  }
}

export async function requireSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (session) return session

  // Carry the attempted path so signing in lands where the person was going,
  // rather than dropping them on the index and making them navigate twice.
  const url = new URL(request.url)
  const next = url.pathname + url.search
  const target = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`
  throw redirect(target)
}

/**
 * Only same-origin paths are accepted as a post-login destination. An absolute
 * URL here would turn the login form into an open redirect that borrows the
 * panel's credibility to send people somewhere else.
 */
export function safeNext(raw: string | null): string {
  if (!raw) return '/links'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/links'
  return raw
}

export function withRefresh(session: Session, headers = new Headers()): Headers {
  if (session.refresh) headers.append('Set-Cookie', session.refresh)
  return headers
}
