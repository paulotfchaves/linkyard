import { createHash, randomBytes } from 'node:crypto'
import { query, queryOne, transaction } from './db.server.ts'
import { hashPassword } from './password.server.ts'
import {
  assertCanDeleteUser,
  assertOwnerTransitionAllowed,
  requirePermission,
  type Action,
  type Actor,
  type Role,
} from './permission.server.ts'

// Membership: who is in this installation, what they may do, and how somebody
// new gets in.
//
// Every mutation here answers to two gates, and they are not redundant. The
// first is the permission table — may this actor touch accounts at all. The
// second is an owner guard, which exists because the dangerous transitions are
// not resource/action cells: an admin holds `user:update` and `user:delete` in
// the baseline, so nothing in that table stops them promoting themselves to
// owner or deleting the owner outright. Both guards live in permission.server
// and are called, never re-implemented — a second copy of a rule is a second
// place for it to drift.

export type MemberStatus = 'active' | 'suspended'

export type MemberRow = {
  id: string
  username: string
  email: string
  role: Role
  status: MemberStatus
  lastSeenAt: Date | null
  createdAt: Date
  linksCreated: number
  grantCount: number
}

/** Ownership is not invitable, so it is not offered by the type either. */
export type InvitableRole = Exclude<Role, 'owner'>

/** The grants table has no `user` member: an account is not scoped to a domain. */
export const GRANTABLE_RESOURCES = ['domain', 'subdomain', 'link'] as const
export type GrantableResource = (typeof GRANTABLE_RESOURCES)[number]

export type GrantInput = {
  resource: GrantableResource
  action: Action
  scopeDomainId: string | null
}

export type GrantView = GrantInput & {
  id: string
  /** The apex the grant is scoped to, or null when it applies everywhere. */
  domainApex: string | null
}

export type InviteRow = {
  id: string
  email: string
  role: InvitableRole
  invitedBy: string | null
  createdAt: Date
  expiresAt: Date
}

export type Invite = {
  token: string
  url: string
  expiresAt: Date
}

// A week is long enough to survive a weekend and short enough that a link
// forwarded into a group chat stops working before anyone finds it again.
export const INVITE_TTL_DAYS = 7

// The path the copied URL points at. Exported so the redemption route and this
// module cannot disagree about where an invite lands.
export const INVITE_PATH = '/join'

const TOKEN_BYTES = 32

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,40}$/

// Same rationale as session tokens: 256 bits of machine randomness has no
// guessable input to slow an attacker over, so a KDF would only add latency.
// The digest is matched by an indexed equality test inside Postgres, which
// keeps the raw token out of any comparison this process performs.
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Mirrors the shape permission.server throws, so a route renders a refusal from
// either module identically. Thrown rather than returned for the same reason:
// React Router turns a thrown Response into the response, which stops a denied
// request before the handler body runs.
function refuse(reason: string): Response {
  return new Response(JSON.stringify({ error: 'forbidden', reason }), {
    status: 403,
    statusText: 'Forbidden',
    headers: { 'content-type': 'application/json' },
  })
}

type MemberDbRow = {
  id: string
  username: string
  email: string
  role: Role
  status: MemberStatus
  last_seen_at: Date | null
  created_at: Date
  links_created: number
  grant_count: number
}

function toMember(row: MemberDbRow): MemberRow {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    linksCreated: row.links_created,
    grantCount: row.grant_count,
  }
}

export async function listMembers(): Promise<MemberRow[]> {
  // Ordered by role and then by name: the list answers "who runs this" before
  // it answers "where is Edith", and alphabetical order buries the owner among
  // the viewers on any installation with more than a handful of people.
  const rows = await query<MemberDbRow>(
    `SELECT u.id, u.username, u.email, u.role, u.status, u.last_seen_at, u.created_at,
            (SELECT count(*) FROM links l
              WHERE l.created_by = u.id AND l.deleted_at IS NULL)::int AS links_created,
            (SELECT count(*) FROM grants g WHERE g.user_id = u.id)::int AS grant_count
       FROM users u
      ORDER BY CASE u.role
                 WHEN 'owner'  THEN 0
                 WHEN 'admin'  THEN 1
                 WHEN 'editor' THEN 2
                 ELSE 3
               END,
               lower(u.username)`
  )
  return rows.map(toMember)
}

type TargetRow = { id: string; role: Role; username: string; email: string; status: MemberStatus }

async function loadTarget(targetId: string): Promise<TargetRow> {
  const row = await queryOne<TargetRow>(
    'SELECT id, role, username, email, status FROM users WHERE id = $1',
    [targetId]
  )
  if (!row) throw new Response('Not found', { status: 404 })
  return row
}

export async function changeRole(actor: Actor, targetId: string, nextRole: Role): Promise<void> {
  await requirePermission(actor, { resource: 'user', action: 'update' })
  const target = await loadTarget(targetId)
  assertOwnerTransitionAllowed(actor, target, nextRole)

  if (target.role === nextRole) return

  // Ownership cannot be handed to an account that cannot sign in. The guard
  // above only inspects roles, so without this an owner could transfer the
  // installation to a suspended user and lock everyone out: the new owner
  // cannot authenticate, and the old one is demoted to admin by the transfer
  // below — leaving nobody who can undo it.
  if (nextRole === 'owner' && target.status !== 'active') {
    throw refuse('reactivate this account before making it the owner')
  }

  // Demoting the owner without naming a successor leaves an installation nobody
  // can administer — the dead end assertCanDeleteUser refuses for deletion, and
  // reachable here only by an owner, since the guard above already stopped
  // everyone else.
  if (target.role === 'owner') {
    throw refuse('promote a successor to owner instead of demoting the only owner')
  }

  await transaction(async (client) => {
    await client.query('UPDATE users SET role = $1 WHERE id = $2', [nextRole, targetId])

    // Ownership is singular. Two owners means two people who can delete each
    // other, and the guards that protect the owner stop protecting anything.
    if (nextRole === 'owner') {
      await client.query(`UPDATE users SET role = 'admin' WHERE role = 'owner' AND id <> $1`, [
        targetId,
      ])
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'user.role', 'user', $2, $3::jsonb, $4::jsonb)`,
      [
        actor.id,
        targetId,
        JSON.stringify({ role: target.role }),
        JSON.stringify({ role: nextRole }),
      ]
    )
  })
}

export async function setStatus(
  actor: Actor,
  targetId: string,
  status: MemberStatus
): Promise<void> {
  await requirePermission(actor, { resource: 'user', action: 'update' })
  const target = await loadTarget(targetId)

  // Suspension is demotion by another name — it strips every ability the role
  // carried — so it answers to the same guard rather than a looser one.
  assertOwnerTransitionAllowed(actor, target, target.role)

  if (status === 'suspended' && actor.id === targetId) {
    throw refuse('suspending your own account would lock you out of this installation')
  }
  if (target.status === status) return

  await transaction(async (client) => {
    await client.query('UPDATE users SET status = $1 WHERE id = $2', [status, targetId])
    // Live sessions need no sweep: resolveSession joins users and requires
    // status = 'active', so a suspended member's cookie stops resolving on the
    // very next request.
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'user.status', 'user', $2, $3::jsonb, $4::jsonb)`,
      [actor.id, targetId, JSON.stringify({ status: target.status }), JSON.stringify({ status })]
    )
  })
}

export async function removeMember(actor: Actor, targetId: string): Promise<void> {
  await requirePermission(actor, { resource: 'user', action: 'delete' })
  const target = await loadTarget(targetId)
  assertCanDeleteUser(actor, target)

  await transaction(async (client) => {
    // Sessions and grants cascade; links.created_by is ON DELETE SET NULL, so
    // removing a person never removes the links they built.
    await client.query('DELETE FROM users WHERE id = $1', [targetId])
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'user.remove', 'user', $2, $3::jsonb)`,
      [
        actor.id,
        targetId,
        JSON.stringify({ username: target.username, email: target.email, role: target.role }),
      ]
    )
  })
}

// ── invites ─────────────────────────────────────────────────────────────────

/**
 * Where the copied link points.
 *
 * An explicit PANEL_ORIGIN wins over the request's own origin, and that
 * ordering is the point: the request origin is derived from a Host header the
 * client controls, and a poisoned one would produce an invite URL pointing at
 * an attacker's copy of the join form — where the new member types the password
 * they are about to use here.
 */
function inviteOrigin(requestOrigin?: string | null): string {
  const configured = process.env.PANEL_ORIGIN?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (requestOrigin) return requestOrigin.replace(/\/+$/, '')
  return ''
}

export async function createInvite(
  actor: Actor,
  input: { email: string; role: InvitableRole; origin?: string | null }
): Promise<Invite> {
  await requirePermission(actor, { resource: 'user', action: 'create' })

  const email = input.email.trim()
  if (!EMAIL_RE.test(email)) throw refuse('that is not an email address')
  if ((input.role as Role) === 'owner') {
    throw refuse('ownership is transferred to an existing account, never invited')
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = await transaction(async (client) => {
    // Re-inviting supersedes rather than adds. The partial unique index would
    // reject the second row anyway; revoking first makes the intent explicit and
    // keeps the superseded token in the audit trail instead of vanishing.
    await client.query(
      `UPDATE invites SET revoked_at = now()
        WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email]
    )

    // Postgres computes the expiry so a container with a skewed clock cannot
    // mint an invite that outlives the policy.
    const created = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO invites (email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))
       RETURNING id, expires_at`,
      [email, input.role, tokenDigest(token), actor.id, INVITE_TTL_DAYS]
    )

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'user.invite', 'invite', $2, $3::jsonb)`,
      [actor.id, created.rows[0].id, JSON.stringify({ email, role: input.role })]
    )
    return created.rows[0].expires_at
  })

  return {
    token,
    url: `${inviteOrigin(input.origin)}${INVITE_PATH}?token=${token}`,
    expiresAt,
  }
}

export async function listPendingInvites(): Promise<InviteRow[]> {
  const rows = await query<{
    id: string
    email: string
    role: InvitableRole
    invited_by: string | null
    created_at: Date
    expires_at: Date
  }>(
    `SELECT i.id, i.email, i.role, u.username AS invited_by, i.created_at, i.expires_at
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      ORDER BY i.created_at DESC`
  )
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }))
}

export async function revokeInvite(actor: Actor, inviteId: string): Promise<void> {
  await requirePermission(actor, { resource: 'user', action: 'delete' })
  await transaction(async (client) => {
    // Stamped, not deleted: the record that somebody was invited and by whom is
    // exactly what an operator wants after an account is compromised.
    const revoked = await client.query(
      `UPDATE invites SET revoked_at = now()
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING email`,
      [inviteId]
    )
    if (!revoked.rowCount) return
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'user.invite.revoke', 'invite', $2, $3::jsonb)`,
      [actor.id, inviteId, JSON.stringify({ email: revoked.rows[0].email })]
    )
  })
}

export type RedeemProblem =
  /** No invite carries that digest. */
  | 'invalid'
  | 'expired'
  | 'used'
  | 'revoked'
  | 'username'
  | 'password'
  /** The chosen username, or the invited address, already belongs to somebody. */
  | 'taken'

export type RedeemResult = { ok: true; userId: string } | { ok: false; problem: RedeemProblem }

/**
 * Why the invite is not looked up before it is claimed.
 *
 * A SELECT that validates followed by an UPDATE that stamps leaves a window two
 * people can both pass — the same link opened twice, or once by a person and
 * once by whatever scanner their mail client runs. The conditional UPDATE is
 * therefore the gate: exactly one caller gets a row back. The lookup afterwards
 * exists only to explain a miss, and cannot grant anything.
 */
export async function redeemInvite(
  token: string,
  input: { username: string; password: string; timezone?: string; locale?: string }
): Promise<RedeemResult> {
  const username = input.username.trim()
  if (!USERNAME_RE.test(username)) return { ok: false, problem: 'username' }
  // Length over composition rules, matching first-run setup: one password
  // policy, or the invited half of the team lives under a different one.
  if (input.password.length < 12 || input.password.length > 200) {
    return { ok: false, problem: 'password' }
  }

  const digest = tokenDigest(token)

  // Hashed before the transaction opens. Argon2id deliberately costs 19 MiB and
  // two passes, and holding a pooled connection through it would let a handful
  // of redemptions starve the panel.
  const passwordHash = await hashPassword(input.password)

  try {
    return await transaction(async (client) => {
      const claimed = await client.query<{ id: string; email: string; role: InvitableRole }>(
        `UPDATE invites SET accepted_at = now()
          WHERE token_hash = $1
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()
          RETURNING id, email, role`,
        [digest]
      )

      if (!claimed.rowCount) {
        const found = await client.query<{ accepted_at: Date | null; revoked_at: Date | null }>(
          'SELECT accepted_at, revoked_at FROM invites WHERE token_hash = $1',
          [digest]
        )
        const row = found.rows[0]
        if (!row) return { ok: false, problem: 'invalid' } as const
        if (row.revoked_at) return { ok: false, problem: 'revoked' } as const
        if (row.accepted_at) return { ok: false, problem: 'used' } as const
        return { ok: false, problem: 'expired' } as const
      }

      const invite = claimed.rows[0]

      // The address comes from the invite, never from the form. An invite is
      // issued to a person; letting the redeemer retype it turns the link into a
      // transferable seat.
      const created = await client.query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, role, timezone, locale)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          username,
          invite.email,
          passwordHash,
          invite.role,
          input.timezone ?? 'UTC',
          input.locale === 'pt-BR' ? 'pt-BR' : 'en',
        ]
      )
      const userId = created.rows[0].id

      await client.query('UPDATE invites SET accepted_by = $1 WHERE id = $2', [userId, invite.id])
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'user.join', 'user', $1, $2::jsonb)`,
        [userId, JSON.stringify({ email: invite.email, role: invite.role, invite: invite.id })]
      )

      return { ok: true, userId } as const
    })
  } catch (err) {
    // A username collision rolls the whole transaction back, invite stamp
    // included — the person retries the same link with another name rather than
    // being told it was already used.
    if (isUniqueViolation(err)) return { ok: false, problem: 'taken' }
    throw err
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

// ── grants ──────────────────────────────────────────────────────────────────

function assertGrantable(grant: GrantInput): void {
  if (!(GRANTABLE_RESOURCES as readonly string[]).includes(grant.resource)) {
    // Refused here rather than left to the table's CHECK, which would surface as
    // a 500 and tell the operator nothing.
    throw refuse(`${grant.resource} cannot be granted per domain`)
  }
}

export async function listGrants(userId: string): Promise<GrantView[]> {
  const rows = await query<{
    id: string
    resource: GrantableResource
    action: Action
    scope_domain_id: string | null
    apex: string | null
  }>(
    `SELECT g.id, g.resource, g.action, g.scope_domain_id, d.apex
       FROM grants g
       LEFT JOIN domains d ON d.id = g.scope_domain_id
      WHERE g.user_id = $1
      ORDER BY g.resource, g.action, d.apex NULLS FIRST`,
    [userId]
  )
  return rows.map((row) => ({
    id: row.id,
    resource: row.resource,
    action: row.action,
    scopeDomainId: row.scope_domain_id,
    domainApex: row.apex,
  }))
}

export async function addGrant(
  actor: Actor,
  userId: string,
  grant: GrantInput
): Promise<void> {
  // Handing out abilities is editing a person's access, so it costs the same
  // permission as changing their role.
  await requirePermission(actor, { resource: 'user', action: 'update' })
  assertGrantable(grant)
  await loadTarget(userId)

  await transaction(async (client) => {
    // The conflict target repeats the expression the unique index is built on,
    // because a grant scoped to every domain stores NULL and NULL is not equal
    // to itself.
    const inserted = await client.query(
      `INSERT INTO grants (user_id, resource, action, scope_domain_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, resource, action,
                    coalesce(scope_domain_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO NOTHING`,
      [userId, grant.resource, grant.action, grant.scopeDomainId]
    )
    if (!inserted.rowCount) return
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'user.grant.add', 'user', $2, $3::jsonb)`,
      [actor.id, userId, JSON.stringify(grant)]
    )
  })
}

export async function removeGrant(
  actor: Actor,
  userId: string,
  grant: GrantInput
): Promise<void> {
  await requirePermission(actor, { resource: 'user', action: 'update' })
  assertGrantable(grant)

  await transaction(async (client) => {
    const removed = await client.query(
      `DELETE FROM grants
        WHERE user_id = $1 AND resource = $2 AND action = $3
          AND scope_domain_id IS NOT DISTINCT FROM $4`,
      [userId, grant.resource, grant.action, grant.scopeDomainId]
    )
    if (!removed.rowCount) return
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'user.grant.remove', 'user', $2, $3::jsonb)`,
      [actor.id, userId, JSON.stringify(grant)]
    )
  })
}
