import { useLoaderData } from 'react-router'
import { useState } from 'react'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { query } from '~/lib/db.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'
import { BulkBar } from '~/components/bulk-bar.tsx'
import { bulkLabels } from '~/lib/bulk-labels.ts'

type DeletedRow = { id: string; host: string; slug: string; target_url: string; deleted_at: string }

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'delete' })

  const rows = await query<DeletedRow>(
    `SELECT l.id, s.host, l.slug, l.target_url, l.deleted_at
       FROM links l JOIN subdomains s ON s.id = l.subdomain_id
      WHERE l.deleted_at IS NOT NULL
      ORDER BY l.deleted_at DESC
      LIMIT 200`
  )
  return Response.json(
    { user: session.user, locale: session.locale, rows },
    { headers: withRefresh(session) }
  )
}

export default function Trash() {
  const data = useLoaderData<{ user: any; locale: Locale; rows: DeletedRow[] }>()
  const [selected, setSelected] = useState<string[]>([])
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
      <PageHeader title={t(locale, 'trash.title')} />

      {data.rows.length === 0 ? (
        <div className="card" style={{ padding: 'var(--card-pad)' }}>
          <p className="t-prose t-muted">{t(locale, 'trash.empty')}</p>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="table__check" />
                <th>{t(locale, 'links.table.column.slug')}</th>
                <th>{t(locale, 'links.table.column.destination')}</th>
                <th>{t(locale, 'trash.deletedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} data-selected={selected.includes(row.id) || undefined}>
                  <td className="table__check" data-label="">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={() =>
                        setSelected(
                          selected.includes(row.id)
                            ? selected.filter((x) => x !== row.id)
                            : [...selected, row.id]
                        )
                      }
                      aria-label={`${t(locale, 'table.selectRow')}: ${row.host}/${row.slug}`}
                    />
                  </td>
                  <td className="mono" data-label={t(locale, 'links.table.column.slug')}>
                    {row.host}/{row.slug}
                  </td>
                  <td className="t-muted" data-label={t(locale, 'links.table.column.destination')}>
                    {row.target_url}
                  </td>
                  <td className="t-faint" data-label={t(locale, 'trash.deletedAt')}>
                    {new Date(row.deleted_at).toLocaleDateString(locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <BulkBar
        trash
        selected={selected}
        tags={[]}
        labels={bulkLabels(locale)}
        locale={locale}
        timezone={data.user.timezone ?? 'UTC'}
        onDone={() => setSelected([])}
      />
    </Shell>
  )
}
