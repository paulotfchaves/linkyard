import { redirect } from 'react-router'
import { clearedCookieHeader, revokeSession } from '~/lib/session.server.ts'

// Signing out revokes the row, not just the cookie. Clearing the cookie alone
// leaves a token that still resolves for anyone who copied it.
export async function action({ request }: { request: Request }) {
  await revokeSession(request)
  return redirect('/login', { headers: { 'Set-Cookie': clearedCookieHeader() } })
}

export async function loader() {
  throw redirect('/login')
}
