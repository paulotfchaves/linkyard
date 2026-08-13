import { redirect, useActionData, useLoaderData, useNavigation } from 'react-router'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission } from '~/lib/permission.server.ts'
import { createLink } from '~/lib/links.server.ts'
import { query } from '~/lib/db.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { LinkEditor } from '~/components/link-editor.tsx'
import { editorLabels, navFor, parseLinkForm } from '~/lib/editor.server.ts'

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'create' })

  const [subdomains, tags] = await Promise.all([
    query<{ id: string; host: string }>('SELECT id, host FROM subdomains WHERE active ORDER BY host'),
    query<{ id: string; name: string }>('SELECT id, name FROM tags WHERE active ORDER BY name'),
  ])

  return Response.json(
    { user: session.user, locale: session.locale, subdomains, tags },
    { headers: withRefresh(session) }
  )
}

export async function action({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'link', action: 'create' })

  const parsed = await parseLinkForm(request, session.locale)
  if ('errors' in parsed) return parsed

  const created = await createLink(parsed.input, session.user.id)
  return redirect(`/links/${created.id}`)
}

export default function NewLink() {
  const data = useLoaderData<any>()
  const actionData = useActionData<{ errors?: Record<string, string> }>()
  const navigation = useNavigation()
  const locale = data.locale as Locale

  return (
    <Shell
      user={data.user}
      nav={navFor(locale)}
      locale={locale}
      localeLabel={t(locale, 'account.language')}
      signOutLabel={t(locale, 'account.signOut')}
      accountLabel={t(locale, 'account.menu')}
    >
      <PageHeader title={t(locale, 'editor.title.new')} />
      <LinkEditor
        values={{
          subdomainId: data.subdomains[0]?.id ?? '',
          slug: '',
          targetUrl: '',
          redirectType: 302,
          utms: {},
          params: [],
          passThrough: false,
          isPinned: false,
          expiresAt: '',
          fallbackUrl: '',
          tagId: '',
          note: '',
        }}
        subdomains={data.subdomains}
        tags={data.tags}
        labels={editorLabels(locale)}
        errors={actionData?.errors ?? {}}
        submitLabel={t(locale, 'editor.submit.new')}
        busy={navigation.state === 'submitting'}
      />
    </Shell>
  )
}
