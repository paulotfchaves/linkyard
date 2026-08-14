import { Link, useLoaderData } from 'react-router'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { query } from '~/lib/db.server.ts'
import { getPendingProvision } from '~/lib/provisioning.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'
import { EmptyState } from '~/components/ui.tsx'

// What this installation answers for: every domain, the hosts under it, and
// whether each host can actually serve a redirect right now.
//
// Read-only, except for one door: connecting a domain lives at /domains/new,
// which is a wizard rather than a form because the work behind it takes minutes
// and survives a closed tab. A job already in flight is surfaced here too — the
// person who closed that tab comes back to this screen, not to the wizard.

type CertStatus = 'pending' | 'issuing' | 'valid' | 'failed'
type Health = 'unknown' | 'ok' | 'degraded' | 'down'
type RootPolicy = 'redirect_apex' | 'branded_page' | 'custom_url'

type DomainRow = {
  id: string
  apex: string
  root_policy: RootPolicy
  verified_at: string | null
  active: boolean
}

type SubdomainRow = {
  id: string
  domain_id: string
  host: string
  record_type: 'CNAME' | 'A' | null
  record_value: string | null
  cert_status: CertStatus
  health: Health
  last_checked_at: string | null
  active: boolean
  link_count: number
}

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  // Resolved here, in the loader, and never in the component: a check that lives
  // in the UI is a check an API request walks straight past.
  await requirePermission(session.user, { resource: 'domain', action: 'read' })

  const [domains, subdomains, pending] = await Promise.all([
    query<DomainRow>(
      `SELECT id, apex, root_policy, verified_at, active FROM domains ORDER BY lower(apex)`
    ),
    // The link count excludes the trash. A host reading "12 links" that stops
    // resolving 12 URLs when it is removed is the only number worth showing
    // next to a delete.
    query<SubdomainRow>(
      `SELECT s.id, s.domain_id, s.host, s.record_type, s.record_value, s.cert_status,
              s.health, s.last_checked_at, s.active,
              (SELECT count(*) FROM links l
                WHERE l.subdomain_id = s.id AND l.deleted_at IS NULL)::int AS link_count
         FROM subdomains s
        ORDER BY lower(s.host)`
    ),
    getPendingProvision(),
  ])

  return Response.json(
    {
      user: session.user,
      locale: session.locale,
      domains,
      subdomains,
      pendingHost: pending?.input.host ?? null,
    },
    { headers: withRefresh(session) }
  )
}

type LoaderData = {
  user: { username: string; email: string; role: string }
  locale: Locale
  domains: DomainRow[]
  subdomains: SubdomainRow[]
  /** A provision somebody started and did not finish — usually because the tab closed. */
  pendingHost: string | null
}

// A certificate that has not been issued is not a failure and not a success.
// Amber for the two in-flight states keeps Ember Orange free to mean "act".
const CERT_TONE: Record<CertStatus, string> = {
  valid: 'active',
  issuing: 'scheduled',
  pending: 'scheduled',
  failed: 'expired',
}

function relative(iso: string | null, locale: Locale): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

function DomainCard({
  domain,
  hosts,
  locale,
}: {
  domain: DomainRow
  hosts: SubdomainRow[]
  locale: Locale
}) {
  return (
    <section className="card domain">
      <header className="domain__head">
        <h2 className="t-title">{domain.apex}</h2>
        <div className="domain__meta">
          <span className="tag">{t(locale, `domains.root.${domain.root_policy}` as never)}</span>
          {!domain.active && <span className="badge badge--paused">{t(locale, 'domains.inactive')}</span>}
          <span className={`badge badge--${domain.verified_at ? 'active' : 'paused'}`}>
            {t(locale, domain.verified_at ? 'domains.verified' : 'domains.unverified')}
          </span>
        </div>
      </header>

      {hosts.length === 0 ? (
        <p className="t-muted domain__empty">{t(locale, 'domains.hosts.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table table--identity-first">
            <thead>
              <tr>
                <th>{t(locale, 'domains.column.host')}</th>
                <th>{t(locale, 'domains.column.record')}</th>
                <th>{t(locale, 'domains.column.certificate')}</th>
                <th>{t(locale, 'domains.column.health')}</th>
                <th className="table__num">{t(locale, 'domains.column.links')}</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => {
                const checked = relative(host.last_checked_at, locale)
                return (
                  <tr key={host.id}>
                    <td className="mono" data-label={t(locale, 'domains.column.host')}>
                      {host.host}
                    </td>
                    <td data-label={t(locale, 'domains.column.record')}>
                      {host.record_type && host.record_value ? (
                        <span className="record">
                          <span className="tag">{host.record_type}</span>
                          <span className="mono record__value" title={host.record_value}>
                            {host.record_value}
                          </span>
                        </span>
                      ) : (
                        <span className="t-faint">{t(locale, 'domains.record.missing')}</span>
                      )}
                    </td>
                    <td data-label={t(locale, 'domains.column.certificate')}>
                      <span className={`badge badge--${CERT_TONE[host.cert_status]}`}>
                        {t(locale, `domains.cert.${host.cert_status}` as never)}
                      </span>
                    </td>
                    <td data-label={t(locale, 'domains.column.health')}>
                      {/* The Honest Number Rule applied to a state: a host nobody
                          has probed reads "not checked", never "healthy". */}
                      <span
                        className={`health health--${host.health}`}
                        title={checked ? t(locale, 'domains.health.checked', { when: checked }) : undefined}
                      >
                        {t(locale, `domains.health.${host.health}` as never)}
                      </span>
                    </td>
                    <td className="table__num tabular" data-label={t(locale, 'domains.column.links')}>
                      {host.link_count.toLocaleString(locale)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function Domains() {
  const data = useLoaderData<LoaderData>()
  const { locale } = data

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
        title={t(locale, 'domains.title')}
        actions={
          <Link to="/domains/new" className="btn btn--primary">
            {t(locale, 'domains.connect')}
            <span className="btn__arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
        }
      />

      {/* An unfinished job is the one thing on this screen that is time-bound:
          it holds the lock, and nobody can connect anything else until it is
          finished or discarded. */}
      {data.pendingHost && (
        <p className="notice card">
          {t(locale, 'domains.pending', { host: data.pendingHost })}{' '}
          <Link to="/domains/new">{t(locale, 'domains.pending.resume')}</Link>
        </p>
      )}

      {data.domains.length === 0 ? (
        <EmptyState
          title={t(locale, 'domains.empty.title')}
          script={t(locale, 'domains.empty.script')}
          body={t(locale, 'domains.empty.body')}
          action={
            <Link to="/domains/new" className="btn btn--primary">
              {t(locale, 'domains.connect')}
              <span className="btn__arrow" aria-hidden="true">
                ↗
              </span>
            </Link>
          }
        />
      ) : (
        data.domains.map((domain) => (
          <DomainCard
            key={domain.id}
            domain={domain}
            hosts={data.subdomains.filter((host) => host.domain_id === domain.id)}
            locale={locale}
          />
        ))
      )}
    </Shell>
  )
}
