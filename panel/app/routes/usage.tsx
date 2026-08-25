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

const decimal = (locale: Locale, value: number, digits = 2) =>
  new Intl.NumberFormat(locale === 'pt-BR' ? 'pt-BR' : 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)

/** Relative time, in words, so "measured at 14:03 UTC" is not the reader's problem. */
function ago(locale: Locale, iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 2) return t(locale, 'usage.ago.now')
  if (minutes < 60) return t(locale, 'usage.ago.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t(locale, 'usage.ago.hours', { n: hours })
  return t(locale, 'usage.ago.days', { n: Math.round(hours / 24) })
}

/**
 * One measurement, stated plainly.
 *
 * No bar behind it: a resource reading has no ceiling to fill against. CPU on a
 * VPS is measured against no quota, and a disk figure without the volume size
 * is a number rather than a proportion — a track behind either would invent a
 * denominator the sample never carried.
 */
function Reading({
  label,
  value,
  unit,
  hint,
}: {
  label: string
  value: string
  unit: string
  hint: string
}) {
  return (
    <div className="reading">
      <dt className="reading__label">{label}</dt>
      <dd className="reading__value">
        <span className="tabular">{value}</span>
        <span className="reading__unit">{unit}</span>
      </dd>
      <p className="reading__hint">{hint}</p>
    </div>
  )
}

export default function Usage() {
  const data = useLoaderData<{ user: any; locale: Locale; status: UsageStatus | null }>()
  const { locale, status } = data

  // What this installation can honestly say.
  //
  // A Compose install on somebody's own server has no bill, so the page leads
  // with the machine it runs on. A Railway install leads with the projection,
  // because that is the number that eventually arrives as an invoice. Before
  // this, every install was shown the Railway version — "$0.00 of $5.00",
  // comfortably inside a plan it was not on.
  const billed = status?.source === 'railway' && status.level !== 'unknown'

  const headline = billed
    ? status!.level === 'over'
      ? t(locale, 'usage.level.over')
      : status!.level === 'warning'
        ? t(locale, 'usage.level.warning')
        : t(locale, 'usage.level.ok')
    : t(locale, 'usage.selfhosted.headline')

  const share =
    status && billed && status.planCeiling > 0 ? status.projected / status.planCeiling : 0

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

      {!status || !status.sampledAt ? (
        <section className="card usage">
          <p className="usage__headline">{t(locale, 'usage.nosample.title')}</p>
          <p className="t-prose t-muted">{t(locale, 'usage.nosample.body')}</p>
        </section>
      ) : (
        <>
          <section className="card usage" data-level={billed ? status.level : 'none'}>
            <p className="usage__headline">{headline}</p>

            {billed ? (
              <>
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
                  <span
                    className="usage__bar-fill"
                    style={{ transform: `scaleX(${Math.min(1, Math.max(0, share))})` }}
                  />
                </div>

                <p className="t-muted usage__cycle">
                  {t(locale, 'usage.daysLeft', { days: status.daysLeft })}
                </p>
              </>
            ) : (
              <p className="t-prose t-muted">{t(locale, 'usage.selfhosted.body')}</p>
            )}
          </section>

          <section className="card usage__server">
            <h2 className="usage__server-title">
              <span>{t(locale, 'usage.server.title')}</span>
              <span className="usage__stamp">{ago(locale, status.sampledAt)}</span>
            </h2>

            <dl className="usage__readings">
              <Reading
                label={t(locale, 'usage.cpu')}
                value={status.cpuVcpu === null ? '—' : decimal(locale, status.cpuVcpu, 2)}
                unit={t(locale, 'usage.cpu.unit')}
                hint={t(locale, 'usage.cpu.hint')}
              />
              <Reading
                label={t(locale, 'usage.memory')}
                value={status.memoryGb === null ? '—' : decimal(locale, status.memoryGb * 1024, 0)}
                unit="MB"
                hint={t(locale, 'usage.memory.hint')}
              />
              <Reading
                label={t(locale, 'usage.disk')}
                value={status.diskGb === null ? '—' : decimal(locale, status.diskGb, 1)}
                unit="GB"
                hint={t(locale, 'usage.disk.hint')}
              />
            </dl>
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
