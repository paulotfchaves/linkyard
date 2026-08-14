import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router'
import { Secret } from '@linkyard/core/secret'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import {
  advanceProvision,
  connectDnsCredential,
  discardProvision,
  getPendingProvision,
  listDnsCredentials,
  loadDnsCredential,
  resolveInfraProvider,
  startProvision,
  type CredentialSummary,
  type DnsConflict,
  type ProvisionStepKey,
  type StepState,
} from '~/lib/provisioning.server.ts'
import type { ScopeVerdict } from '~/lib/dns/cloudflare.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'
import { Button, Field, TextInput } from '~/components/ui.tsx'

// Connecting a domain, as a screen.
//
// One step per form post, deliberately. The work behind this — a host at the
// infrastructure provider, two DNS records, a certificate that takes minutes —
// cannot be held open in a request, and pretending otherwise produces a spinner
// that dies with the tab. Every post asks the server to do the next thing and
// re-renders where the job got to, so a reload, a second tab, and a laptop that
// woke up an hour later all land on the same screen.
//
// The refusals get more room than the happy path, because they are where a
// person needs the product to explain itself: a token that reaches too much, a
// DNS record that belongs to somebody else, a certificate still validating.

const STEPS: ProvisionStepKey[] = ['infra', 'dns', 'certificate', 'record']

type SerializedJob = {
  id: string
  host: string
  zoneName: string
  steps: Record<ProvisionStepKey, StepState>
  certificate: string | null
  cnameTarget: string | null
  error: string | null
}

type LoaderData = {
  user: { username: string; email: string; role: string }
  locale: Locale
  credentials: CredentialSummary[]
  selected: string | null
  zones: { id: string; name: string }[]
  zonesFailed: boolean
  hasInfra: boolean
  job: SerializedJob | null
}

type ActionData =
  | { kind: 'connected' }
  | { kind: 'error'; code: string; detail?: string; host?: string }
  | { kind: 'scope'; verdict: ScopeVerdict; zoneName: string }
  | { kind: 'conflict'; conflict: DnsConflict; host: string }
  | { kind: 'waiting'; reason: 'certificate' | 'propagating'; host: string }
  | { kind: 'failed'; detail: string }

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  // Resolved in the loader, never in the component: a check that lives in the
  // UI is a check a direct POST walks straight past.
  await requirePermission(session.user, { resource: 'domain', action: 'create' })

  const credentials = await listDnsCredentials()
  const job = await getPendingProvision()

  const asked = new URL(request.url).searchParams.get('credential')
  const selected =
    credentials.find((credential) => credential.id === asked)?.id ?? credentials[0]?.id ?? null

  let zones: { id: string; name: string }[] = []
  let zonesFailed = false
  // Skipped while a job is running: the screen shows the job, and a live call
  // to Cloudflare on every poll would spend the operator's rate limit on a list
  // nobody is reading.
  if (selected && !job) {
    try {
      const credential = await loadDnsCredential(selected)
      zones = (await credential.provider.listZones()).map((zone) => ({
        id: zone.id,
        name: zone.name,
      }))
    } catch {
      zonesFailed = true
    }
  }

  return Response.json(
    {
      user: session.user,
      locale: session.locale,
      credentials,
      selected,
      zones,
      zonesFailed,
      hasInfra: resolveInfraProvider() !== null,
      job: job
        ? {
            id: job.id,
            host: job.input.host,
            zoneName: job.input.zoneName,
            steps: job.steps,
            certificate: job.certificate,
            cnameTarget: job.cnameTarget,
            error: job.error,
          }
        : null,
    } satisfies LoaderData,
    { headers: withRefresh(session) }
  )
}

export async function action({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'domain', action: 'create' })

  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')

  if (intent === 'connect') {
    const raw = String(form.get('token') ?? '').trim()
    // Refused here rather than sent: an empty field is a slip, and telling
    // somebody "Cloudflare rejected this" when nothing was ever asked of
    // Cloudflare sends them to debug the wrong thing.
    if (raw.length < 8) return Response.json({ kind: 'error', code: 'too_short' })
    // Wrapped immediately, and never held as a bare string beyond this line:
    // from here on it prints as [redacted] through every logging path.
    const result = await connectDnsCredential({
      label: String(form.get('label') ?? ''),
      token: new Secret(raw),
      userId: session.user.id,
    })
    if (!result.ok) {
      return Response.json({ kind: 'error', code: result.code, detail: result.detail })
    }
    return redirect(`/domains/new?credential=${encodeURIComponent(result.credential.id)}`)
  }

  if (intent === 'start') {
    const credentialId = String(form.get('credentialId') ?? '')
    const zoneId = String(form.get('zoneId') ?? '')
    const zoneName = String(form.get('zoneName') ?? '')
    let dns
    try {
      dns = (await loadDnsCredential(credentialId)).provider
    } catch {
      return Response.json({ kind: 'error', code: 'credential_gone' })
    }

    const started = await startProvision(
      { userId: session.user.id, credentialId, zoneId, prefix: String(form.get('prefix') ?? '') },
      { dns }
    )
    if (started.ok) return Response.json({ kind: 'connected' })

    if (started.code === 'scope') {
      return Response.json({ kind: 'scope', verdict: started.verdict, zoneName })
    }
    return Response.json({
      kind: 'error',
      code: started.code,
      detail: 'detail' in started ? started.detail : undefined,
      host: 'host' in started ? started.host : undefined,
    })
  }

  if (intent === 'discard') {
    await discardProvision(String(form.get('jobId') ?? ''))
    return Response.json({ kind: 'connected' })
  }

  if (intent === 'advance') {
    const job = await getPendingProvision()
    if (!job) return redirect('/domains')

    const infra = resolveInfraProvider()
    if (!infra) return Response.json({ kind: 'error', code: 'no_infra' })

    let dns
    try {
      dns = (await loadDnsCredential(job.input.credentialId ?? '')).provider
    } catch {
      return Response.json({ kind: 'error', code: 'credential_gone' })
    }

    const result = await advanceProvision(
      job.id,
      { dns, infra },
      { overwriteCname: form.get('overwrite') === '1' }
    )

    switch (result.status) {
      case 'done':
        return redirect('/domains')
      case 'conflict':
        return Response.json({ kind: 'conflict', conflict: result.conflict, host: job.input.host })
      case 'blocked':
        return Response.json({ kind: 'scope', verdict: result.verdict, zoneName: job.input.zoneName })
      case 'waiting':
        return Response.json({ kind: 'waiting', reason: result.reason, host: job.input.host })
      case 'failed':
        return Response.json({ kind: 'failed', detail: result.error })
      default:
        return Response.json({ kind: 'connected' })
    }
  }

  throw new Response('Bad request', { status: 400 })
}

// ------------------------------------------------------------------ rendering

// Danger carries the wash and the coral outline; a plain notice borrows the
// card's hairline instead, because a bare .notice has padding and no surface
// and would read as text that lost its box.
function Notice({ tone, children }: { tone: 'danger' | 'plain'; children: React.ReactNode }) {
  return <p className={tone === 'danger' ? 'notice notice--danger' : 'notice card'}>{children}</p>
}

function ScopeRefusal({ verdict, zone, locale }: { verdict: ScopeVerdict; zone: string; locale: Locale }) {
  if (verdict.ok) return null

  return (
    <div className="card editor__section">
      <h2 className="t-title">{t(locale, 'domains.new.scope.title')}</h2>
      <p className="t-prose">{t(locale, 'domains.new.scope.body', { zone })}</p>
      {verdict.reason === 'all_zones' && (
        <p className="field__hint">{t(locale, 'domains.new.scope.all')}</p>
      )}
      {(verdict.reason === 'extra_zones' || verdict.reason === 'wrong_zone') && (
        // Shown rather than summarised: "too broad" is an accusation, and the
        // list is the evidence for it.
        <p className="field__hint mono">
          {t(locale, 'domains.new.scope.list', { zones: verdict.zones.join(', ') })}
        </p>
      )}
      {verdict.reason === 'missing_permission' && (
        <p className="field__hint">
          {t(locale, 'domains.new.scope.missing', {
            permissions: verdict.missing
              .map((permission) => t(locale, `domains.new.scope.permission.${permission}` as never))
              .join(', '),
          })}
        </p>
      )}
    </div>
  )
}

function ConflictRefusal({
  conflict,
  host,
  locale,
  busy,
}: {
  conflict: DnsConflict
  host: string
  locale: Locale
  busy: boolean
}) {
  return (
    <div className="card editor__section">
      <h2 className="t-title">{t(locale, 'domains.new.conflict.title')}</h2>
      {conflict.kind === 'address_record' && (
        <p className="t-prose">
          {t(locale, 'domains.new.conflict.address', {
            host,
            type: conflict.recordType,
            value: conflict.value,
          })}
        </p>
      )}
      {conflict.kind === 'foreign_cname' && (
        <p className="t-prose">
          {t(locale, 'domains.new.conflict.foreign', { host, value: conflict.value })}
        </p>
      )}
      {conflict.kind === 'stale_cname' && (
        <>
          <p className="t-prose">
            {t(locale, 'domains.new.conflict.stale', { host, value: conflict.value })}
          </p>
          {/* The only overwrite this product performs, and only after the
              person has read the value that is about to be replaced. */}
          <Form method="post" className="editor__actions">
            <input type="hidden" name="intent" value="advance" />
            <input type="hidden" name="overwrite" value="1" />
            <Button type="submit" tone="danger" disabled={busy}>
              {t(locale, 'domains.new.conflict.replace')}
            </Button>
          </Form>
        </>
      )}
    </div>
  )
}

function Steps({
  steps,
  locale,
}: {
  steps: Record<ProvisionStepKey, StepState>
  locale: Locale
}) {
  const current = STEPS.find((step) => steps[step] !== 'ok')

  return (
    <ol className="editor__section card" style={{ listStyle: 'none', margin: 0 }}>
      {STEPS.map((step) => {
        const done = steps[step] === 'ok'
        const now = step === current
        return (
          <li
            key={step}
            style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}
          >
            <span
              aria-hidden="true"
              className="tag tabular"
              style={{ minWidth: '2.25rem', textAlign: 'center' }}
            >
              {done ? '✓' : STEPS.indexOf(step) + 1}
            </span>
            <span className={done || now ? 't-title' : 't-muted'}>
              {t(locale, `domains.new.step.${step}` as never)}
            </span>
            {now && <span className="badge badge--scheduled">{t(locale, 'domains.new.step.now')}</span>}
          </li>
        )
      })}
    </ol>
  )
}

function ConnectToken({
  locale,
  busy,
  error,
  // This form can appear twice on one page — on its own, and folded inside
  // "use a different account". Two inputs sharing an id would send every label
  // on the second copy to the first copy's field.
  idPrefix,
}: {
  locale: Locale
  busy: boolean
  error: string | null
  idPrefix: string
}) {
  const labelId = `${idPrefix}-label`
  const tokenId = `${idPrefix}-token`

  return (
    <Form method="post" className="card editor__section">
      <input type="hidden" name="intent" value="connect" />
      <h2 className="t-title">{t(locale, 'domains.new.token.title')}</h2>
      <p className="t-prose">{t(locale, 'domains.new.token.body')}</p>
      {error && <Notice tone="danger">{error}</Notice>}

      <Field
        id={labelId}
        label={t(locale, 'domains.new.token.label')}
        hint={t(locale, 'domains.new.token.labelHint')}
      >
        <TextInput id={labelId} name="label" autoComplete="off" placeholder="Cloudflare" />
      </Field>

      <Field
        id={tokenId}
        label={t(locale, 'domains.new.token.field')}
        hint={t(locale, 'domains.new.token.hint')}
      >
        {/* type=password and autoComplete=off: a credential must not be offered
            back by a browser on a shared machine, and must not sit in plain
            sight while somebody screen-shares this screen. */}
        <TextInput id={tokenId} name="token" type="password" autoComplete="off" spellCheck={false} required />
      </Field>

      <div className="editor__actions">
        <Button type="submit" tone="primary" arrow disabled={busy}>
          {t(locale, 'domains.new.token.submit')}
        </Button>
      </div>
    </Form>
  )
}

export default function NewDomain() {
  const data = useLoaderData<LoaderData>()
  const outcome = useActionData<ActionData>()
  const navigation = useNavigation()
  const { locale } = data
  const busy = navigation.state !== 'idle'

  const credential = data.credentials.find((item) => item.id === data.selected) ?? null
  const errorText =
    outcome?.kind === 'error'
      ? t(locale, `domains.new.error.${outcome.code}` as never, {
          detail: outcome.detail ?? '',
          host: outcome.host ?? '',
        })
      : null

  return (
    <Shell
      user={data.user}
      nav={navFor(locale)}
      locale={locale}
      localeLabel={t(locale, 'account.language')}
      signOutLabel={t(locale, 'account.signOut')}
      accountLabel={t(locale, 'account.menu')}
    >
      <PageHeader title={t(locale, 'domains.new.title')} />

      <div className="editor">
        {!data.hasInfra && <Notice tone="danger">{t(locale, 'domains.new.error.no_infra')}</Notice>}

        {outcome?.kind === 'scope' && (
          <ScopeRefusal verdict={outcome.verdict} zone={outcome.zoneName} locale={locale} />
        )}
        {outcome?.kind === 'conflict' && (
          <ConflictRefusal conflict={outcome.conflict} host={outcome.host} locale={locale} busy={busy} />
        )}
        {outcome?.kind === 'failed' && (
          <Notice tone="danger">{t(locale, 'domains.new.failed', { detail: outcome.detail })}</Notice>
        )}
        {outcome?.kind === 'waiting' && (
          <Notice tone="plain">
            {t(locale, `domains.new.waiting.${outcome.reason}` as never, { host: outcome.host })}
          </Notice>
        )}

        {data.job ? (
          <>
            <h2 className="t-title">{t(locale, 'domains.new.inflight', { host: data.job.host })}</h2>
            <Steps steps={data.job.steps} locale={locale} />
            {data.job.cnameTarget && (
              <p className="field__hint mono">
                {t(locale, 'domains.new.target', { value: data.job.cnameTarget })}
              </p>
            )}
            <div className="editor__actions">
              <Form method="post">
                <input type="hidden" name="intent" value="advance" />
                <Button type="submit" tone="primary" arrow disabled={busy || !data.hasInfra}>
                  {t(locale, outcome?.kind === 'waiting' ? 'domains.new.recheck' : 'domains.new.continue')}
                </Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="discard" />
                <input type="hidden" name="jobId" value={data.job.id} />
                <Button type="submit" disabled={busy}>
                  {t(locale, 'domains.new.discard')}
                </Button>
              </Form>
            </div>
          </>
        ) : !credential ? (
          <ConnectToken locale={locale} busy={busy} error={errorText} idPrefix="first" />
        ) : (
          <>
            {errorText && <Notice tone="danger">{errorText}</Notice>}

            <Form method="post" className="card editor__section">
              <input type="hidden" name="intent" value="start" />
              <input type="hidden" name="credentialId" value={credential.id} />

              <div>
                <span className="t-label t-muted">{t(locale, 'domains.new.credential')}</span>
                <p className="t-title">
                  {credential.label} <span className="mono t-faint">····{credential.last4}</span>
                </p>
                {/* What the token reaches, before it is used — the same fact the
                    gate is about to judge, shown while it is still cheap to fix. */}
                <p className="field__hint">
                  {credential.scopes?.zones === 'all'
                    ? t(locale, 'domains.new.credential.reachAll')
                    : t(locale, 'domains.new.credential.reach', {
                        count: credential.scopes?.zones.length ?? 0,
                      })}
                </p>
              </div>

              {data.zonesFailed && <Notice tone="danger">{t(locale, 'domains.new.zonesFailed')}</Notice>}

              <Field id="zoneId" label={t(locale, 'domains.new.zone')} hint={t(locale, 'domains.new.zone.hint')}>
                <select id="zoneId" name="zoneId" className="field__input" required>
                  {data.zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field id="prefix" label={t(locale, 'domains.new.prefix')} hint={t(locale, 'domains.new.prefix.hint')}>
                <TextInput id="prefix" name="prefix" defaultValue="go" autoComplete="off" required />
              </Field>

              <div className="editor__actions">
                <Button type="submit" tone="primary" arrow disabled={busy || data.zones.length === 0}>
                  {t(locale, 'domains.new.submit')}
                </Button>
              </div>
            </Form>

            <details>
              <summary className="t-muted">{t(locale, 'domains.new.token.another')}</summary>
              <div style={{ marginTop: '0.75rem' }}>
                <ConnectToken locale={locale} busy={busy} error={null} idPrefix="another" />
              </div>
            </details>
          </>
        )}
      </div>
    </Shell>
  )
}
