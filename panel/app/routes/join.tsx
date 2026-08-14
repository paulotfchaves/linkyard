import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router'
import { redeemInvite, type RedeemProblem } from '~/lib/members.server.ts'
import { createSession, sessionCookieHeader } from '~/lib/session.server.ts'
import { resolveLocale, t, LOCALES, type Locale } from '~/lib/i18n/index.ts'
import { Button, Field, TextInput, EmberPanel } from '~/components/ui.tsx'

// Accepting an invite. A threshold surface, like sign-in and first-run: one
// framed ember panel, one script word, staggered reveal.
//
// The token is never validated before it is claimed. A SELECT that checks
// followed by an UPDATE that stamps leaves a window two people can both pass,
// so the claim is a single statement and the failure comes back from it.

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token') ?? ''
  // Absent token is a 404, not an error page: a bare /join is not a surface
  // this product has, and saying so confirms nothing about which tokens exist.
  if (!token) throw new Response('Not found', { status: 404 })

  return {
    locale: resolveLocale({ acceptLanguage: request.headers.get('accept-language') }),
    token,
  }
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData()
  const token = String(form.get('token') ?? '')
  const locale = resolveLocale({ acceptLanguage: request.headers.get('accept-language') })

  const result = await redeemInvite(token, {
    username: String(form.get('username') ?? ''),
    password: String(form.get('password') ?? ''),
    timezone: String(form.get('timezone') ?? 'UTC'),
    locale: String(form.get('locale') ?? locale),
  })

  if (!result.ok) return { problem: result.problem }

  // Signed in immediately. Asking somebody to accept an invite and then log in
  // with credentials they just chose is a step that exists only because the
  // code found it convenient.
  const session = await createSession(result.userId, {
    ip: request.headers.get('x-forwarded-for'),
    userAgent: request.headers.get('user-agent'),
  })
  return redirect('/links', {
    headers: { 'Set-Cookie': sessionCookieHeader(session.token, session.expiresAt) },
  })
}

export default function Join() {
  const { locale, token } = useLoaderData<{ locale: Locale; token: string }>()
  const actionData = useActionData<{ problem?: RedeemProblem }>()
  const navigation = useNavigation()
  const problem = actionData?.problem
  const dead = problem === 'invalid' || problem === 'expired' || problem === 'used' || problem === 'revoked'

  return (
    <div className="threshold">
      <EmberPanel>
        <div className="threshold__inner">
          <div className="reveal">
            <span className="wordmark">
              <span className="wordmark__glyph" aria-hidden="true" />
              {t(locale, 'app.name')}
            </span>
          </div>

          <div className="reveal reveal-1">
            <h1 className="t-display">
              {t(locale, 'join.title')} <span className="t-script">{t(locale, 'join.script')}</span>
            </h1>
            <p style={{ color: 'var(--on-panel-muted)', marginTop: '0.5rem' }}>
              {dead ? t(locale, `join.error.${problem}` as never) : t(locale, 'join.subtitle')}
            </p>
          </div>

          {/* A dead invite gets no form. Leaving the fields there invites
              somebody to type a password into a link that cannot work. */}
          {!dead && (
            <Form
              method="post"
              className="reveal reveal-2"
              style={{ display: 'grid', gap: '0.875rem' }}
            >
              <input type="hidden" name="token" value={token} />
              <input
                type="hidden"
                name="timezone"
                defaultValue="UTC"
                ref={(node) => {
                  if (node && !node.dataset.filled) {
                    node.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
                    node.dataset.filled = 'true'
                  }
                }}
              />

              <Field
                label={t(locale, 'setup.username.label')}
                id="username"
                error={problem === 'username' ? t(locale, 'validation.field.required') : null}
              >
                <TextInput id="username" name="username" required autoFocus autoComplete="username" />
              </Field>

              <Field
                label={t(locale, 'setup.password.label')}
                id="password"
                hint={t(locale, 'setup.password.hint')}
                error={problem === 'password' ? t(locale, 'setup.password.hint') : null}
              >
                <TextInput
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </Field>

              <Field label={t(locale, 'setup.locale.label')} id="locale">
                <select id="locale" name="locale" className="field__input" defaultValue={locale}>
                  {LOCALES.map((code) => (
                    <option key={code} value={code}>
                      {code === 'en' ? 'English' : 'Português (Brasil)'}
                    </option>
                  ))}
                </select>
              </Field>

              <Button tone="primary" type="submit" arrow disabled={navigation.state === 'submitting'}>
                {t(locale, 'join.submit')}
              </Button>
            </Form>
          )}
        </div>
      </EmberPanel>
    </div>
  )
}
