import { redirect, useActionData, useLoaderData, useNavigation } from 'react-router'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { getLink, updateLink, UTM_KEYS } from '~/lib/links.server.ts'
import { query } from '~/lib/db.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { LinkEditor } from '~/components/link-editor.tsx'
import { editorLabels, navFor, parseLinkForm } from '~/lib/editor.server.ts'

export async function loader({ request, params }: { request: Request; params: { id: string } }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'read' })

  const link = await getLink(params.id)
  if (!link) throw new Response('Not found', { status: 404 })

  const [subdomains, tags] = await Promise.all([
    query<{ id: string; host: string }>('SELECT id, host FROM subdomains WHERE active ORDER BY host'),
    query<{ id: string; name: string }>('SELECT id, name FROM tags WHERE active ORDER BY name'),
  ])

  return Response.json(
    { user: session.user, locale: session.locale, link, subdomains, tags },
    { headers: withRefresh(session) }
  )
}

export async function action({ request, params }: { request: Request; params: { id: string } }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'update' })

  const parsed = await parseLinkForm(request, session.locale)
  if ('errors' in parsed) return parsed

  await updateLink(params.id, parsed.input, session.user.id)
  return redirect('/links')
}

export default function EditLink() {
  const data = useLoaderData<any>()
  const actionData = useActionData<{ errors?: Record<string, string> }>()
  const navigation = useNavigation()
  const locale = data.locale as Locale
  const link = data.link

  const utms: Record<string, string> = {}
  for (const key of UTM_KEYS) if (link[key]) utms[key] = link[key]

  return (
    <Shell
      user={data.user}
      nav={navFor(locale)}
      locale={locale}
      localeLabel={t(locale, 'account.language')}
      signOutLabel={t(locale, 'account.signOut')}
      accountLabel={t(locale, 'account.menu')}
    >
      <PageHeader title={t(locale, 'editor.title.edit')} lead={`${link.host}/${link.slug}`} />
      <LinkEditor
        values={{
          subdomainId: link.subdomain_id,
          slug: link.slug,
          targetUrl: link.target_url,
          redirectType: link.redirect_type,
          utms,
          params: Object.entries(link.params ?? {}).map(([key, value]) => ({
            key,
            value: String(value),
          })),
          passThrough: link.pass_through,
          isPinned: link.is_pinned,
          expiresAt: link.expires_at ? String(link.expires_at).slice(0, 16) : '',
          fallbackUrl: link.fallback_url ?? '',
          tagId: link.tag_id ?? '',
          note: link.note ?? '',
        }}
        subdomains={data.subdomains}
        tags={data.tags}
        labels={editorLabels(locale)}
        errors={actionData?.errors ?? {}}
        submitLabel={t(locale, 'editor.submit.edit')}
        busy={navigation.state === 'submitting'}
      />
    </Shell>
  )
}
