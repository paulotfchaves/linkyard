import { useLoaderData } from 'react-router'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { usageStatus, type UsageStatus } from '~/lib/usage.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  // Reading the bill is a domain-level concern: it is the same person who
  // decides whether another subdomain is worth its share of the plan.
  await requirePermission(session.user, { resource: 'domain', action: 'read' })

  // usageStatus never throws by contract — it degrades to a local sample. It is
  // still wrapped, because a page that 500s is a page nobody can use to find
  // out why the bill is climbing.
  let status: UsageStatus | null = null
  try {
    status = await usageStatus()
  } catch {
    status = null
  }

  return Response.json(
    { user: session.user, locale: session.locale, status },
    { headers: withRefresh(session) }
  )
}

const money = (locale: Locale, value: number) =>
  new Intl.NumberFormat(locale === 'pt-BR' ? 'pt-BR' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value)

export default function Usage() {
  const data = useLoaderData<{ user: any; locale: Locale; status: UsageStatus | null }>()
  const { locale, status } = data

  const level = status?.level ?? 'ok'
  const headline =
    level === 'over'
      ? t(locale, 'usage.level.over')
      : level === 'warning'
        ? t(locale, 'usage.level.warning')
        : t(locale, 'usage.level.ok')

  // The share of the allowance, capped for the bar only. The number beside it
  // is never capped: an installation at 240% of its plan needs to read 240%,
  // not a bar that has been full for a week.
  const share = status && status.planCeiling > 0 ? status.projected / status.planCeiling : 0
  const barWidth = `${Math.min(100, Math.max(0, share * 100))}%`

  return (
    <Shell
      user={data.user}
      nav={navFor(locale)}
      locale={locale}
      localeLabel={t(locale, 'account.language')}
      signOutLabel={t(locale, 'account.signOut')}
      accountLabel={t(locale, 'account.menu')}
    >
      <PageHeader title={t(locale, 'usage.title')} />

      {!status ? (
        <div className="card" style={{ padding: 'var(--card-pad)' }}>
          <p className="t-prose t-muted">{t(locale, 'usage.unavailable')}</p>
        </div>
      ) : (
        <>
          <section className="card usage" data-level={level}>
            <p className="usage__headline">{headline}</p>

            <p className="usage__figure">
              <strong className="tabular">{money(locale, status.projected)}</strong>
              <span className="t-muted">
                {t(locale, 'usage.of', { ceiling: money(locale, status.planCeiling) })}
              </span>
            </p>

            <div
              className="usage__bar"
              role="meter"
              aria-valuenow={Math.round(share * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t(locale, 'usage.title')}
            >
              <span className="usage__bar-fill" style={{ width: barWidth }} />
            </div>

            <p className="t-muted usage__cycle">
              {t(locale, 'usage.daysLeft', { days: status.daysLeft })}
            </p>
          </section>

          {status.advice.length > 0 && (
            <section className="card usage__advice">
              <h2 className="usage__advice-title">{t(locale, 'usage.advice')}</h2>
              <ul className="usage__advice-list">
                {status.advice.map((line) => (
                  <li key={line} className="t-prose">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Shell>
  )
}
