import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router'
import { queryOne } from '~/lib/db.server.ts'
import { verifyPassword } from '~/lib/password.server.ts'
import { createSession, sessionCookieHeader } from '~/lib/session.server.ts'
import { getSession, safeNext } from '~/lib/auth.server.ts'
import { isClaimed } from '~/lib/setup.server.ts'
import { resolveLocale, t, type Locale } from '~/lib/i18n/index.ts'
import { Button, Field, TextInput, EmberPanel } from '~/components/ui.tsx'

export async function loader({ request }: { request: Request }) {
  if (!(await isClaimed())) throw redirect('/setup')
  if (await getSession(request)) throw redirect('/links')

  const locale = resolveLocale({ acceptLanguage: request.headers.get('accept-language') })
  const url = new URL(request.url)
  return { locale, next: safeNext(url.searchParams.get('next')) }
}

type UserRow = {
  id: string
  password_hash: string
  status: string
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData()
  const email = String(form.get('email') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const next = safeNext(String(form.get('next') ?? ''))
  const locale = resolveLocale({ acceptLanguage: request.headers.get('accept-language') })

  const user = await queryOne<UserRow>(
    'SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1)',
    [email]
  )

  // The same failure for an unknown address and a wrong password: telling them
  // apart turns the form into a directory of who has an account here.
  const ok = user ? await verifyPassword(user.password_hash, password) : false
  if (!user || !ok) {
    return { error: t(locale, 'login.error.invalid') }
  }
  if (user.status !== 'active') {
    return { error: t(locale, 'login.error.suspended') }
  }

  const { token, expiresAt } = await createSession(user.id, {
    ip: request.headers.get('x-forwarded-for'),
    userAgent: request.headers.get('user-agent'),
  })

  return redirect(next, {
    headers: { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
  })
}

export default function Login() {
  const { locale, next } = useLoaderData<{ locale: Locale; next: string }>()
  const actionData = useActionData<{ error?: string }>()
  const navigation = useNavigation()
  const busy = navigation.state === 'submitting'

  return (
    <div className="threshold">
      <EmberPanel className="threshold__panel">
        <div className="threshold__inner">
          <div className="reveal">
            <span className="wordmark">
              <span className="wordmark__glyph" aria-hidden="true" />
              {t(locale, 'app.name')}
            </span>
          </div>

          <div className="reveal reveal-1">
            <h1 className="t-display">
              {t(locale, 'login.title')} <span className="t-script">{t(locale, 'login.script')}</span>
            </h1>
            <p style={{ color: 'var(--on-panel-muted)', marginTop: '0.5rem' }}>
              {t(locale, 'login.subtitle')}
            </p>
          </div>

          <Form method="post" className="reveal reveal-2" style={{ display: 'grid', gap: '0.875rem' }}>
            <input type="hidden" name="next" value={next} />

            <Field label={t(locale, 'login.email.label')} id="email">
              <TextInput
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
              />
            </Field>

            <Field label={t(locale, 'login.password.label')} id="password" error={actionData?.error}>
              <TextInput
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                invalid={Boolean(actionData?.error)}
              />
            </Field>

            <Button tone="primary" type="submit" arrow disabled={busy}>
              {t(locale, 'login.submit')}
            </Button>
          </Form>
        </div>
      </EmberPanel>
    </div>
  )
}
