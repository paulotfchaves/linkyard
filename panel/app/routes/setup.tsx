import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router'
import {
  claimInstallation,
  isClaimed,
  setupTokenMatches,
  validateSetup,
  type SetupProblem,
} from '~/lib/setup.server.ts'
import { sessionCookieHeader } from '~/lib/session.server.ts'
import { resolveLocale, t, LOCALES, type Locale } from '~/lib/i18n/index.ts'
import { Button, Field, TextInput, EmberPanel } from '~/components/ui.tsx'

// A closed setup route answers 404, not 403. A 403 would confirm that this is a
// Linkyard installation waiting to be claimed, which is precisely the signal
// somebody watching Certificate Transparency logs is looking for.
function notFound(): never {
  throw new Response('Not found', { status: 404 })
}

export async function loader({ request }: { request: Request }) {
  if (await isClaimed()) notFound()

  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (!setupTokenMatches(token)) notFound()

  return {
    locale: resolveLocale({ acceptLanguage: request.headers.get('accept-language') }),
    token,
  }
}

export async function action({ request }: { request: Request }) {
  if (await isClaimed()) notFound()

  const form = await request.formData()
  if (!setupTokenMatches(String(form.get('token') ?? ''))) notFound()

  const input = {
    username: String(form.get('username') ?? ''),
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
    timezone: String(form.get('timezone') ?? 'UTC'),
    locale: String(form.get('locale') ?? 'en'),
  }

  const problem = validateSetup(input)
  if (problem) return { problem }

  const { token, expiresAt } = await claimInstallation(input, {
    ip: request.headers.get('x-forwarded-for'),
    userAgent: request.headers.get('user-agent'),
  })

  return redirect('/links', { headers: { 'Set-Cookie': sessionCookieHeader(token, expiresAt) } })
}

export default function Setup() {
  const { locale, token } = useLoaderData<{ locale: Locale; token: string }>()
  const actionData = useActionData<{ problem?: SetupProblem }>()
  const navigation = useNavigation()
  const busy = navigation.state === 'submitting'
  const problem = actionData?.problem

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
            <h1 className="t-display">{t(locale, 'setup.title')}</h1>
            <p style={{ color: 'var(--on-panel-muted)', marginTop: '0.5rem' }}>
              {t(locale, 'setup.subtitle')}
            </p>
          </div>

          <Form
            method="post"
            className="reveal reveal-2"
            style={{ display: 'grid', gap: '0.875rem' }}
          >
            <input type="hidden" name="token" value={token} />
            {/* Resolved in the browser and posted back: the server has no way to
                know which zone the person is sitting in, and guessing UTC for
                everyone makes every scheduled swap fire at the wrong hour. */}
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
              label={t(locale, 'setup.email.label')}
              id="email"
              error={problem === 'email' ? t(locale, 'validation.field.required') : null}
            >
              <TextInput id="email" name="email" type="email" required autoComplete="email" />
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

            <Button tone="primary" type="submit" arrow disabled={busy}>
              {t(locale, 'setup.submit')}
            </Button>
          </Form>
        </div>
      </EmberPanel>
    </div>
  )
}
