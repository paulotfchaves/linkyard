import { Form, useActionData, useLoaderData, useNavigation } from 'react-router'
import { useState } from 'react'
import { requireSession, withRefresh } from '~/lib/auth.server.ts'
import { requirePermission, ROLES, ACTIONS, type Actor, type Role } from '~/lib/permission.server.ts'
import {
  addGrant,
  changeRole,
  createInvite,
  GRANTABLE_RESOURCES,
  listGrants,
  listMembers,
  listPendingInvites,
  removeGrant,
  removeMember,
  revokeInvite,
  setStatus,
  type GrantableResource,
  type GrantView,
  type InvitableRole,
  type MemberRow,
} from '~/lib/members.server.ts'
import { query } from '~/lib/db.server.ts'
import { t, type Locale } from '~/lib/i18n/index.ts'
import { Shell, PageHeader } from '~/components/shell.tsx'
import { navFor } from '~/lib/editor-labels.ts'
import { Button } from '~/components/ui.tsx'

// Who is in this installation, and what they may do beyond their role.
//
// Every mutation is a form post to this route's action, which re-checks
// permission and the owner guards server-side. Nothing here decides anything by
// hiding a control: the controls a person may not use are hidden to keep the
// table quiet, and refused again on the server if they arrive anyway.
//
// The role, ability, and resource lists travel down inside the loader payload
// rather than being imported by the component. React Router strips server code
// only from `loader` and `action`, so a component that names a constant from a
// `.server` module drags the whole permission layer — and its database pool —
// into the browser bundle, and the build says so.

type SerializedMember = Omit<MemberRow, 'lastSeenAt' | 'createdAt'> & {
  lastSeenAt: string | null
  createdAt: string
}

type SerializedInvite = {
  id: string
  email: string
  role: InvitableRole
  invitedBy: string | null
  createdAt: string
  expiresAt: string
}

type LoaderData = {
  user: { id: string; username: string; email: string; role: Role }
  locale: Locale
  members: SerializedMember[]
  invites: SerializedInvite[]
  grants: Record<string, GrantView[]>
  domains: Array<{ id: string; apex: string }>
  roles: readonly Role[]
  abilities: readonly Ability[]
  resources: readonly GrantableResource[]
}

type Ability = (typeof ACTIONS)[number]

type ActionData =
  | { error: string }
  | { ok: true }
  | { ok: true; invite: { url: string; expiresAt: string } }

export async function loader({ request }: { request: Request }) {
  const session = await requireSession(request)
  await requirePermission(session.user, { resource: 'user', action: 'read' })

  const [members, invites, domains] = await Promise.all([
    listMembers(),
    listPendingInvites(),
    query<{ id: string; apex: string }>('SELECT id, apex FROM domains ORDER BY lower(apex)'),
  ])

  // Grants are fetched per member rather than in one join because the set is
  // small by construction — a grant is the exception, not the rule — and one
  // query per row here keeps listGrants the single place the shape is defined.
  const grants: Record<string, GrantView[]> = {}
  for (const member of members) {
    grants[member.id] = member.grantCount > 0 ? await listGrants(member.id) : []
  }

  return Response.json(
    {
      user: session.user,
      locale: session.locale,
      members,
      invites,
      grants,
      domains,
      roles: ROLES,
      abilities: ACTIONS,
      resources: GRANTABLE_RESOURCES,
    },
    { headers: withRefresh(session) }
  )
}

function asRole(value: FormDataEntryValue | null): Role {
  const role = String(value ?? '')
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new Response('Bad request', { status: 400 })
  }
  return role as Role
}

export async function action({ request }: { request: Request }) {
  const session = await requireSession(request)
  const actor: Actor = { id: session.user.id, role: session.user.role }
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')
  const targetId = String(form.get('userId') ?? '')

  try {
    switch (intent) {
      case 'role':
        await changeRole(actor, targetId, asRole(form.get('role')))
        break
      case 'status':
        await setStatus(actor, targetId, form.get('status') === 'suspended' ? 'suspended' : 'active')
        break
      case 'remove':
        await removeMember(actor, targetId)
        break
      case 'invite': {
        const invite = await createInvite(actor, {
          email: String(form.get('email') ?? ''),
          role: asRole(form.get('role')) as InvitableRole,
          origin: new URL(request.url).origin,
        })
        // The token crosses the wire exactly once, to the person who asked for
        // it. It is never stored in the loader's payload, so a reload does not
        // put it back on screen.
        return Response.json({
          ok: true,
          invite: { url: invite.url, expiresAt: invite.expiresAt.toISOString() },
        })
      }
      case 'invite.revoke':
        await revokeInvite(actor, String(form.get('inviteId') ?? ''))
        break
      case 'grant.add':
      case 'grant.remove': {
        const grant = {
          resource: String(form.get('resource') ?? '') as GrantableResource,
          action: String(form.get('ability') ?? '') as (typeof ACTIONS)[number],
          scopeDomainId: String(form.get('scopeDomainId') ?? '') || null,
        }
        if (intent === 'grant.add') await addGrant(actor, targetId, grant)
        else await removeGrant(actor, targetId, grant)
        break
      }
      default:
        throw new Response('Bad request', { status: 400 })
    }
  } catch (err) {
    // A guard throws a Response so it can short-circuit a loader. Here it is
    // caught and returned instead, because a refusal is information this screen
    // can show in place — an error page would lose the table the person was
    // reading.
    if (err instanceof Response && err.status === 403) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    throw err
  }

  return Response.json({ ok: true })
}

function roleLabel(locale: Locale, role: string): string {
  return t(locale, `account.role.${role}` as never)
}

function grantLabel(locale: Locale, grant: GrantView): string {
  const what = t(locale, `members.resource.${grant.resource}` as never)
  const may = t(locale, `members.act.${grant.action}` as never)
  const where = grant.domainApex ?? t(locale, 'members.grants.everywhere')
  return `${may} ${what} · ${where}`
}

/**
 * Destructive actions ask twice, in place.
 *
 * A native confirm() would be a second, unstyled dialog for something that fits
 * in the row it belongs to, and it cannot say which account is about to go.
 */
function ConfirmButton({
  label,
  cancelLabel,
  children,
}: {
  label: string
  cancelLabel: string
  children: React.ReactNode
}) {
  const [armed, setArmed] = useState(false)
  if (!armed) {
    return (
      <Button small type="button" onClick={() => setArmed(true)}>
        {label}
      </Button>
    )
  }
  return (
    <span className="confirm">
      {children}
      <Button small type="button" onClick={() => setArmed(false)}>
        {cancelLabel}
      </Button>
    </span>
  )
}

export default function Members() {
  const data = useLoaderData<LoaderData>()
  const result = useActionData<ActionData>()
  const navigation = useNavigation()
  const { locale } = data

  const [grantee, setGrantee] = useState(
    () => data.members.find((member) => member.id !== data.user.id)?.id ?? data.user.id
  )

  const busy = navigation.state !== 'idle'
  const invite = result && 'invite' in result ? result.invite : null
  const refused = result && 'error' in result

  return (
    <Shell
      user={data.user}
      nav={navFor(locale)}
      locale={locale}
      localeLabel={t(locale, 'account.language')}
      signOutLabel={t(locale, 'account.signOut')}
      accountLabel={t(locale, 'account.menu')}
    >
      <PageHeader title={t(locale, 'members.title')} />

      {refused && (
        <p className="notice notice--danger" role="alert">
          {t(locale, 'members.error')}
        </p>
      )}

      <div className="card table-wrap">
        <table className="table table--identity-first">
          <thead>
            <tr>
              <th>{t(locale, 'members.column.member')}</th>
              <th>{t(locale, 'members.column.role')}</th>
              <th>{t(locale, 'members.column.status')}</th>
              <th>{t(locale, 'members.column.lastSeen')}</th>
              <th>{t(locale, 'members.column.access')}</th>
              <th className="table__num">{t(locale, 'members.column.links')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => {
              const self = member.id === data.user.id
              const isOwner = member.role === 'owner'
              const extra = data.grants[member.id] ?? []
              return (
                <tr key={member.id}>
                  <td data-label={t(locale, 'members.column.member')}>
                    <span className="member">
                      <span className="member__name">
                        {member.username}
                        {self && <span className="t-faint"> ({t(locale, 'members.you')})</span>}
                      </span>
                      <span className="t-faint member__email">{member.email}</span>
                    </span>
                  </td>
                  <td data-label={t(locale, 'members.column.role')}>
                    {isOwner ? (
                      // Every transition out of this cell is refused: ownership is
                      // singular, so demoting the only owner has no successor and
                      // the guard says so. Promoting somebody else is the move,
                      // and it lives one row down.
                      <span className="tag" title={t(locale, 'members.owner.note')}>
                        {roleLabel(locale, member.role)}
                      </span>
                    ) : (
                      <Form method="post" replace>
                        <input type="hidden" name="intent" value="role" />
                        <input type="hidden" name="userId" value={member.id} />
                        <select
                          className="chip"
                          name="role"
                          defaultValue={member.role}
                          aria-label={`${t(locale, 'members.column.role')}: ${member.username}`}
                          disabled={busy}
                          onChange={(event) => event.currentTarget.form?.requestSubmit()}
                        >
                          {data.roles
                            // Offering owner to an admin would offer a click that
                            // assertOwnerTransitionAllowed refuses every time.
                            .filter((role) => role !== 'owner' || data.user.role === 'owner')
                            .map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(locale, role)}
                              </option>
                            ))}
                        </select>
                      </Form>
                    )}
                  </td>
                  <td data-label={t(locale, 'members.column.status')}>
                    <span className={`badge badge--${member.status === 'active' ? 'active' : 'paused'}`}>
                      {t(locale, `members.status.${member.status}` as never)}
                    </span>
                  </td>
                  <td className="t-muted tabular" data-label={t(locale, 'members.column.lastSeen')}>
                    {member.lastSeenAt
                      ? new Date(member.lastSeenAt).toLocaleDateString(locale, { dateStyle: 'medium' })
                      : t(locale, 'members.lastSeen.never')}
                  </td>
                  <td data-label={t(locale, 'members.column.access')}>
                    {extra.length === 0 ? (
                      <span className="t-faint">—</span>
                    ) : (
                      <span className="tag">{t(locale, 'members.grants.count', { count: extra.length })}</span>
                    )}
                  </td>
                  <td className="table__num tabular" data-label={t(locale, 'members.column.links')}>
                    {member.linksCreated.toLocaleString(locale)}
                  </td>
                  {/* The owner row carries no actions at all, and self-suspension
                      carries none either — both are permanently refused by the
                      guards, so a button there could only ever fail. The server
                      refuses them again regardless of what this renders. The
                      class goes with the content: on a phone `.row-actions`
                      draws a divider, and a divider above nothing reads as a
                      control that failed to load. */}
                  <td className={isOwner ? undefined : 'row-actions'} data-label="">
                    <span className="member-actions">
                      {!isOwner && !self && (
                        <Form method="post" replace>
                          <input type="hidden" name="intent" value="status" />
                          <input type="hidden" name="userId" value={member.id} />
                          <input
                            type="hidden"
                            name="status"
                            value={member.status === 'active' ? 'suspended' : 'active'}
                          />
                          <Button small type="submit" disabled={busy}>
                            {t(
                              locale,
                              member.status === 'active'
                                ? 'members.action.suspend'
                                : 'members.action.restore'
                            )}
                          </Button>
                        </Form>
                      )}

                      {!isOwner && (
                        <ConfirmButton
                          label={t(locale, 'members.action.remove')}
                          cancelLabel={t(locale, 'common.cancel')}
                        >
                          <Form method="post" replace>
                            <input type="hidden" name="intent" value="remove" />
                            <input type="hidden" name="userId" value={member.id} />
                            <Button small tone="danger" type="submit" disabled={busy}>
                              {t(locale, 'members.action.confirm')}
                            </Button>
                          </Form>
                        </ConfirmButton>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="panel-pair">
        <section className="card invite">
          <h2 className="t-title">{t(locale, 'members.invite.title')}</h2>
          <p className="t-muted">{t(locale, 'members.invite.body')}</p>

          <Form method="post" replace className="invite__form">
            <input type="hidden" name="intent" value="invite" />
            <div className="field">
              <label className="field__label" htmlFor="invite-email">
                {t(locale, 'members.invite.email')}
              </label>
              <input
                id="invite-email"
                className="field__input"
                type="email"
                name="email"
                required
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="invite-role">
                {t(locale, 'members.invite.role')}
              </label>
              {/* Owner is absent by construction: ownership is transferred to an
                  account that already exists, never handed to whoever opens a
                  link. The server refuses it too. */}
              <select id="invite-role" className="field__input" name="role" defaultValue="editor">
                {(['admin', 'editor', 'viewer'] as InvitableRole[]).map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(locale, role)}
                  </option>
                ))}
              </select>
            </div>
            <Button tone="primary" type="submit" arrow disabled={busy}>
              {t(locale, 'members.invite.submit')}
            </Button>
          </Form>

          {invite && <InviteLink url={invite.url} expiresAt={invite.expiresAt} locale={locale} />}

          <h3 className="t-label t-muted">{t(locale, 'members.invite.pending')}</h3>
          {data.invites.length === 0 ? (
            <p className="t-faint">{t(locale, 'members.invite.pending.empty')}</p>
          ) : (
            <ul className="invite__list">
              {data.invites.map((row) => (
                <li key={row.id} className="invite__row">
                  <span className="invite__who">
                    <span>{row.email}</span>
                    <span className="t-faint">
                      {roleLabel(locale, row.role)} ·{' '}
                      {t(locale, 'members.invite.expires', {
                        date: new Date(row.expiresAt).toLocaleDateString(locale, {
                          dateStyle: 'medium',
                        }),
                      })}
                    </span>
                  </span>
                  <Form method="post" replace>
                    <input type="hidden" name="intent" value="invite.revoke" />
                    <input type="hidden" name="inviteId" value={row.id} />
                    <Button small type="submit" disabled={busy}>
                      {t(locale, 'members.invite.revoke')}
                    </Button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card invite">
          <h2 className="t-title">{t(locale, 'members.grants.title')}</h2>
          <p className="t-muted">{t(locale, 'members.grants.body')}</p>

          <div className="field">
            <label className="field__label" htmlFor="grant-member">
              {t(locale, 'members.grants.member')}
            </label>
            <select
              id="grant-member"
              className="field__input"
              value={grantee}
              onChange={(event) => setGrantee(event.currentTarget.value)}
            >
              {data.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.username} — {roleLabel(locale, member.role)}
                </option>
              ))}
            </select>
          </div>

          {(data.grants[grantee] ?? []).length === 0 ? (
            <p className="t-faint">{t(locale, 'members.grants.none')}</p>
          ) : (
            <ul className="grant__list">
              {(data.grants[grantee] ?? []).map((grant) => (
                <li key={grant.id} className="grant">
                  <span>{grantLabel(locale, grant)}</span>
                  <Form method="post" replace>
                    <input type="hidden" name="intent" value="grant.remove" />
                    <input type="hidden" name="userId" value={grantee} />
                    <input type="hidden" name="resource" value={grant.resource} />
                    <input type="hidden" name="ability" value={grant.action} />
                    <input type="hidden" name="scopeDomainId" value={grant.scopeDomainId ?? ''} />
                    <button
                      type="submit"
                      className="icon-btn"
                      disabled={busy}
                      aria-label={t(locale, 'members.grants.remove')}
                      title={t(locale, 'members.grants.remove')}
                    >
                      ×
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          )}

          <Form method="post" replace className="grant__form">
            <input type="hidden" name="intent" value="grant.add" />
            <input type="hidden" name="userId" value={grantee} />
            <div className="field">
              <label className="field__label" htmlFor="grant-ability">
                {t(locale, 'members.grants.action')}
              </label>
              <select id="grant-ability" className="field__input" name="ability" defaultValue="create">
                {data.abilities.map((ability) => (
                  <option key={ability} value={ability}>
                    {t(locale, `members.act.${ability}` as never)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="grant-resource">
                {t(locale, 'members.grants.resource')}
              </label>
              <select id="grant-resource" className="field__input" name="resource" defaultValue="link">
                {data.resources.map((resource) => (
                  <option key={resource} value={resource}>
                    {t(locale, `members.resource.${resource}` as never)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="grant-scope">
                {t(locale, 'members.grants.scope')}
              </label>
              <select id="grant-scope" className="field__input" name="scopeDomainId" defaultValue="">
                <option value="">{t(locale, 'members.grants.everywhere')}</option>
                {data.domains.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.apex}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy}>
              {t(locale, 'members.grants.add')}
            </Button>
          </Form>
        </section>
      </div>
    </Shell>
  )
}

function InviteLink({
  url,
  expiresAt,
  locale,
}: {
  url: string
  expiresAt: string
  locale: Locale
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="invite__ready" role="status">
      <p className="field__hint">
        {t(locale, 'members.invite.ready')}{' '}
        {t(locale, 'members.invite.expires', {
          date: new Date(expiresAt).toLocaleDateString(locale, { dateStyle: 'medium' }),
        })}
      </p>
      <div className="invite__link">
        {/* Selectable, not just copyable: a clipboard permission can be denied,
            and the link is the only way the invited person gets in. */}
        <code className="mono">{url}</code>
        <button
          type="button"
          className="icon-btn"
          title={t(locale, copied ? 'table.copied' : 'members.invite.copy')}
          aria-label={t(locale, copied ? 'table.copied' : 'members.invite.copy')}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch {
              /* clipboard denied: the URL is visible and selectable anyway */
            }
          }}
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
    </div>
  )
}
