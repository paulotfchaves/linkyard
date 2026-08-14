import { Link, useLoaderData, useSearchParams } from 'react-router'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { buildReport, defaultRange, type Report } from '~/lib/reports.server.ts'
import { query } from '~/lib/db.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'
import { Metric, Button } from '~/components/ui.tsx'

const RANGES = [7, 30, 90] as const

function scopeFrom(url: URL) {
  const linkId = url.searchParams.get('link')
  return {
    linkIds: linkId ? [linkId] : undefined,
    domainId: url.searchParams.get('domain') ?? undefined,
    tagId: url.searchParams.get('tag') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
  }
}

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'read' })

  const url = new URL(request.url)
  const days = Number(url.searchParams.get('days') ?? '30')
  const scope = scopeFrom(url)

  const [report, domains, tags, link] = await Promise.all([
    buildReport(scope, { ...defaultRange(RANGES.includes(days as never) ? days : 30), compareTo: 'previous' }),
    query<{ id: string; apex: string }>('SELECT id, apex FROM domains ORDER BY apex'),
    query<{ id: string; name: string }>('SELECT id, name FROM tags WHERE active ORDER BY name'),
    scope.linkIds
      ? query<{ id: string; slug: string; host: string }>(
          `SELECT l.id, l.slug, s.host FROM links l
             JOIN subdomains s ON s.id = l.subdomain_id
            WHERE l.id = $1`,
          [scope.linkIds[0]]
        )
      : Promise.resolve([]),
  ])

  return Response.json(
    { user: session.user, locale: session.locale, report, domains, tags, link: link[0] ?? null, days },
    { headers: withRefresh(session) }
  )
}

type Data = {
  user: { username: string; email: string; role: string }
  locale: Locale
  report: Report
  domains: Array<{ id: string; apex: string }>
  tags: Array<{ id: string; name: string }>
  link: { id: string; slug: string; host: string } | null
  days: number
}

function Sparkline({ series }: { series: Report['series'] }) {
  const max = Math.max(1, ...series.map((p) => p.clicks))
  const width = 100
  const step = series.length > 1 ? width / (series.length - 1) : width
  const points = series
    .map((p, i) => `${(i * step).toFixed(2)},${(30 - (p.clicks / max) * 28).toFixed(2)}`)
    .join(' ')

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${width} 30`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth="1.2" />
    </svg>
  )
}

function BreakdownList({ title, rows, other }: { title: string; rows: Report['byCountry']; other: string }) {
  if (!rows.length) return null
  return (
    <section className="card breakdown">
      <h2 className="t-label t-muted">{title}</h2>
      <ul className="breakdown__list">
        {rows.map((row) => (
          <li key={row.key} className="breakdown__row">
            <span className="breakdown__label">{row.key === 'other' ? other : row.label}</span>
            {/* The bar is the comparison; the number is the fact. Both, because
                a share alone hides how small the whole set might be. */}
            <span className="breakdown__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(2, row.share)}%` }} />
            </span>
            <span className="breakdown__value tabular">{row.clicks.toLocaleString()}</span>
            <span className="breakdown__share tabular t-faint">{row.share.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function Reports() {
  const data = useLoaderData<Data>()
  const [params, setParams] = useSearchParams()
  const { locale, report } = data

  function setDays(days: number) {
    const next = new URLSearchParams(params)
    next.set('days', String(days))
    setParams(next)
  }

  const exportHref = `/reports/export?${params.toString()}`
  const scoped = data.link ? `${data.link.host}/${data.link.slug}` : null

  return (
    <Shell
      user={data.user}
      nav={navFor(locale)}
      locale={locale}
      localeLabel={t(locale, 'account.language')}
      signOutLabel={t(locale, 'account.signOut')}
      accountLabel={t(locale, 'account.menu')}
    >
      <PageHeader
        title={t(locale, 'reports.title')}
        lead={scoped ?? undefined}
        actions={
          <a className="btn btn--quiet" href={exportHref} download>
            {t(locale, 'reports.export')}
          </a>
        }
      />

      <div className="filters">
        {RANGES.map((days) => (
          <button
            key={days}
            type="button"
            className="chip"
            aria-pressed={data.days === days}
            onClick={() => setDays(days)}
          >
            {t(locale, `reports.range.${days}` as never)}
          </button>
        ))}
        {scoped && (
          <Link to="/reports" className="chip">
            {t(locale, 'links.filter.clear')}
          </Link>
        )}
      </div>

      {report.totals.clicks === 0 && report.totals.bots === 0 ? (
        <div className="card" style={{ padding: 'var(--card-pad)' }}>
          <p className="t-prose t-muted">{t(locale, 'reports.empty')}</p>
        </div>
      ) : (
        <>
          <section className="card metrics">
            <Metric
              value={report.totals.clicks.toLocaleString()}
              caption={t(locale, 'reports.clicks')}
              note={
                report.change?.clicks != null
                  ? `${report.change.clicks > 0 ? '+' : ''}${report.change.clicks}% ${t(locale, 'reports.compare')}`
                  : undefined
              }
            />
            <Metric
              value={report.totals.visitDays.toLocaleString()}
              caption={t(locale, 'reports.visitDays')}
              note={t(locale, 'reports.visitDays.note')}
            />
            <Metric
              value={report.totals.bots.toLocaleString()}
              caption={t(locale, 'reports.bots')}
              note={t(locale, 'reports.bots.note')}
            />
            <Metric value={String(report.totals.links)} caption={t(locale, 'reports.links')} />
          </section>

          <section className="card chart">
            <Sparkline series={report.series} />
            <div className="chart__axis t-faint">
              <span>{report.range.from}</span>
              {report.peak && (
                <span>
                  {t(locale, 'reports.peak', { day: report.peak.day })} ·{' '}
                  <span className="tabular">{report.peak.clicks.toLocaleString()}</span>
                </span>
              )}
              <span>{report.range.to}</span>
            </div>
          </section>

          <div className="breakdowns">
            <BreakdownList
              title={t(locale, 'reports.byCountry')}
              rows={report.byCountry}
              other={t(locale, 'reports.other')}
            />
            <BreakdownList
              title={t(locale, 'reports.byDevice')}
              rows={report.byDevice}
              other={t(locale, 'reports.other')}
            />
            <BreakdownList
              title={t(locale, 'reports.byBrowser')}
              rows={report.byBrowser}
              other={t(locale, 'reports.other')}
            />
            <BreakdownList
              title={t(locale, 'reports.byReferrer')}
              rows={report.byReferrer}
              other={t(locale, 'reports.other')}
            />
          </div>

          {report.topLinks.length > 0 && (
            <section className="card breakdown">
              <h2 className="t-label t-muted">{t(locale, 'reports.topLinks')}</h2>
              <ul className="breakdown__list">
                {report.topLinks.map((row) => (
                  <li key={row.id} className="breakdown__row">
                    <Link to={`/reports?link=${row.id}`} className="breakdown__label mono">
                      {row.host}/{row.slug}
                    </Link>
                    <span className="breakdown__bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(2, row.share)}%` }} />
                    </span>
                    <span className="breakdown__value tabular">{row.clicks.toLocaleString()}</span>
                    <span className="breakdown__share tabular t-faint">{row.share.toFixed(1)}%</span>
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
