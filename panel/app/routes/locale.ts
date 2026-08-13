import { redirect } from 'react-router'
import { query } from '~/lib/db.server.ts'
import { requireSession } from '~/lib/auth.server.ts'
import { isLocale } from '~/lib/i18n/index.ts'

// The choice lands on the user row rather than in a cookie, so it follows the
// person to another browser instead of being a property of this one.
export async function action({ request }: { request: Request }) {
  const { user } = await requireSession(request)
  const form = await request.formData()
  const next = String(form.get('locale') ?? '')

  if (isLocale(next)) {
    await query('UPDATE users SET locale = $1 WHERE id = $2', [next, user.id])
  }

  const referer = request.headers.get('referer')
  let back = '/links'
  if (referer) {
    try {
      const url = new URL(referer)
      // Same-origin only: a referer is attacker-controllable and this would
      // otherwise be an open redirect wearing a language switch as a disguise.
      if (url.origin === new URL(request.url).origin) back = url.pathname + url.search
    } catch {
      /* malformed referer falls through to the default */
    }
  }
  return redirect(back)
}
