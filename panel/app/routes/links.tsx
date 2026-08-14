import { Form, Link, useLoaderData, useSearchParams } from 'react-router'
import { useState } from 'react'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission, resolvePermissions } from '~/lib/permission.server.ts'
import { listLinks, linkStatus, type LinkStatus } from '~/lib/links.server.ts'
import { query } from '~/lib/db.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'
import { LinksTable, type LinkRowView } from '~/components/links-table.tsx'
import { BulkBar } from '~/components/bulk-bar.tsx'
import { bulkLabels } from '~/lib/bulk-labels.ts'
import { EmptyState, Button } from '~/components/ui.tsx'

const STATUSES: Array<LinkStatus | 'all'> = ['all', 'active', 'paused', 'scheduled', 'expired']

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  // Permission is resolved here, in the loader, and never in the component. A
  // check that lives in the UI is a check an API request walks straight past.
  await requirePermission(session.user, { resource: 'link', action: 'read' })

  const url = new URL(request.url)
  const filters = {
    search: url.searchParams.get('q'),
    domainId: url.searchParams.get('domain'),
    tagId: url.searchParams.get('tag'),
    status: (url.searchParams.get('status') as LinkStatus | 'all' | null) ?? 'all',
    sort: (url.searchParams.get('sort') as 'recent' | 'clicks' | 'slug') ?? 'recent',
    page: Number(url.searchParams.get('page') ?? '1') || 1,
  }

  // Two capabilities, not one: creating a link and editing existing ones are
  // separate grants, and a role that has one without the other is a role the
  // grant model allows.
  const capabilities = await resolvePermissions(session.user, {
    create: { resource: 'link', action: 'create' },
    update: { resource: 'link', action: 'update' },
  })

  const [{ rows, total, page, perPage }, domains, tags] = await Promise.all([
    listLinks(filters),
    query<{ id: string; apex: string }>('SELECT id, apex FROM domains ORDER BY apex'),
    query<{ id: string; name: string }>('SELECT id, name FROM tags WHERE active ORDER BY name'),
  ])

  const links: LinkRowView[] = rows.map((row) => ({
    id: row.id,
    host: row.host,
    slug: row.slug,
    targetUrl: row.target_url,
    status: linkStatus(row),
    tagName: row.tag_name,
    clicks: row.clicks,
    isPinned: row.is_pinned,
  }))

  return Response.json(
    {
      user: session.user,
      locale: session.locale,
      capabilities,
      links,
      domains,
      tags,
      total,
      page,
      perPage,
      anyFilter: Boolean(filters.search || filters.domainId || filters.tagId),
    },
    { headers: withRefresh(session) }
  )
}

type LoaderData = {
  user: { username: string; email: string; role: string; timezone: string }
  locale: Locale
  capabilities: { create: boolean; update: boolean }
  links: LinkRowView[]
  domains: Array<{ id: string; apex: string }>
  tags: Array<{ id: string; name: string }>
  total: number
  page: number
  perPage: number
  anyFilter: boolean
}

export default function Links() {
  const data = useLoaderData<LoaderData>()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string[]>([])
  const { locale } = data

  const labels = {
    slug: t(locale, 'links.table.column.slug'),
    destination: t(locale, 'links.table.column.destination'),
    tag: t(locale, 'links.table.column.tag'),
    status: t(locale, 'links.table.column.status'),
    clicks: t(locale, 'links.table.column.clicks'),
    selectAll: t(locale, 'table.selectAll'),
    selectRow: t(locale, 'table.selectRow'),
    copy: t(locale, 'table.copy'),
    copied: t(locale, 'table.copied'),
    pinned: t(locale, 'table.pinned'),
    edit: t(locale, 'links.action.edit'),
    clear: t(locale, 'table.clear'),
    selectedCount: (n: number) => `${n}`,
    active: t(locale, 'links.status.active'),
    paused: t(locale, 'links.status.paused'),
    scheduled: t(locale, 'links.status.scheduled'),
    expired: t(locale, 'links.status.expired'),
  }

  const status = params.get('status') ?? 'all'
  const totalPages = Math.max(1, Math.ceil(data.total / data.perPage))

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null || value === '' || value === 'all') next.delete(key)
    else next.set(key, value)
    next.delete('page')
    setParams(next)
  }

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
        title={t(locale, 'links.title')}
        actions={
          data.capabilities.create ? (
            <Link to="/links/new" className="btn btn--primary">
              {t(locale, 'links.new')}
              <span className="btn__arrow" aria-hidden="true">
                ↗
              </span>
            </Link>
          ) : null
        }
      />

      {data.links.length === 0 && !data.anyFilter ? (
        <EmptyState
          title={t(locale, 'links.table.empty.title')}
          script="yet"
          body={t(locale, 'links.table.empty.body')}
          action={
            data.capabilities.create ? (
              <Link to="/links/new" className="btn btn--primary">
                {t(locale, 'links.table.empty.action')}
                <span className="btn__arrow" aria-hidden="true">
                  ↗
                </span>
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <Form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
            <div className="filters__search">
              <input
                type="search"
                className="field__input"
                placeholder={t(locale, 'links.filter.search')}
                aria-label={t(locale, 'links.filter.search')}
                defaultValue={params.get('q') ?? ''}
                onChange={(e) => setParam('q', e.currentTarget.value)}
              />
            </div>

            {STATUSES.map((value) => (
              <button
                key={value}
                type="button"
                className="chip"
                aria-pressed={status === value}
                onClick={() => setParam('status', value)}
              >
                {value === 'all'
                  ? t(locale, 'links.filter.status.all')
                  : t(locale, `links.status.${value}` as never)}
              </button>
            ))}

            {data.domains.length > 1 && (
              <select
                className="chip"
                aria-label={t(locale, 'links.filter.domain')}
                value={params.get('domain') ?? ''}
                onChange={(e) => setParam('domain', e.currentTarget.value)}
              >
                <option value="">{t(locale, 'links.filter.domain.all')}</option>
                {data.domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.apex}
                  </option>
                ))}
              </select>
            )}
          </Form>

          <LinksTable
            rows={data.links}
            labels={labels}
            selected={selected}
            onSelectedChange={setSelected}
            canWrite={data.capabilities.update}
          />

          <div className="pager">
            <span className="t-muted tabular">
              {t(locale, 'pager.showing', {
                from: (data.page - 1) * data.perPage + 1,
                to: Math.min(data.page * data.perPage, data.total),
                total: data.total,
              })}
            </span>
            {totalPages > 1 && (
              <div className="pager__pages">
                <Button
                  small
                  disabled={data.page <= 1}
                  onClick={() => setParams({ ...Object.fromEntries(params), page: String(data.page - 1) })}
                >
                  {t(locale, 'pager.previous')}
                </Button>
                <Button
                  small
                  disabled={data.page >= totalPages}
                  onClick={() => setParams({ ...Object.fromEntries(params), page: String(data.page + 1) })}
                >
                  {t(locale, 'pager.next')}
                </Button>
              </div>
            )}
          </div>

          <BulkBar
            selected={data.capabilities.update ? selected : []}
            tags={data.tags}
            labels={bulkLabels(locale)}
            locale={locale}
            timezone={data.user.timezone ?? 'UTC'}
            onDone={() => setSelected([])}
          />
        </>
      )}
    </Shell>
  )
}
