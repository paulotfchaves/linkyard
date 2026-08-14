import { requireSession } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { exportReportCsv, defaultRange } from '~/lib/reports.server.ts'

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'read' })

  const url = new URL(request.url)
  const linkId = url.searchParams.get('link')
  const days = Number(url.searchParams.get('days') ?? '30')

  const csv = await exportReportCsv(
    {
      linkIds: linkId ? [linkId] : undefined,
      domainId: url.searchParams.get('domain') ?? undefined,
      tagId: url.searchParams.get('tag') ?? undefined,
      search: url.searchParams.get('q') ?? undefined,
    },
    { ...defaultRange(Number.isFinite(days) ? days : 30), compareTo: null }
  )

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="linkyard-report-${stamp}.csv"`,
      // A report is a snapshot of a moving number; a cached copy would be a
      // different answer to the same question with no way to tell.
      'cache-control': 'no-store',
    },
  })
}
