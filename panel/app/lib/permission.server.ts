import { query } from './db.server'

// The permission model, in one sentence: a role sets the baseline, and grants
// only ever widen it.
//
// There are no deny rules, and adding one later would be a mistake. A model
// that both widens and narrows forces every check to answer "which rule wins",
// and that question is where authorization bugs live. Restricting somebody here
// means giving them a lower role plus the exact grants they need — a viewer
// with `link:create` scoped to one domain can operate links in that domain and
// nowhere else.

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const
export const RESOURCES = ['domain', 'subdomain', 'link'] as const
export const ACTIONS = ['create', 'read', 'update', 'delete'] as const

export type Role = (typeof ROLES)[number]
export type Resource = (typeof RESOURCES)[number]
export type Action = (typeof ACTIONS)[number]

export type Actor = { id: string; role: Role }

/** scopeDomainId null means the grant applies in every domain. */
export type Grant = {
  resource: Resource
  action: Action
  scopeDomainId: string | null
}

export type PermissionRequest = {
  resource: Resource
  action: Action
  domainId?: string | null
}

type Ability = `${Resource}:${Action}`

const EVERY_ABILITY: readonly Ability[] = [
  'domain:create',
  'domain:read',
  'domain:update',
  'domain:delete',
  'subdomain:create',
  'subdomain:read',
  'subdomain:update',
  'subdomain:delete',
  'link:create',
  'link:read',
  'link:update',
  'link:delete',
]

// Every cell is spelled out rather than computed. A generated permission table
// is a table nobody actually reads before shipping it.
const BASELINE: Readonly<Record<Role, ReadonlySet<Ability>>> = {
  owner: new Set(EVERY_ABILITY),
  // An admin matches the owner on every resource. The one thing an admin cannot
  // do — remove or demote the owner — is not a resource/action pair, so it is
  // enforced by assertNotOwnerDemotion instead of by this table.
  admin: new Set(EVERY_ABILITY),
  editor: new Set<Ability>([
    'domain:read',
    'subdomain:read',
    'link:create',
    'link:read',
    'link:update',
    'link:delete',
  ]),
  viewer: new Set<Ability>(['domain:read', 'subdomain:read', 'link:read', 'link:create']),
}

function forbidden(reason: string): Response {
  return new Response(JSON.stringify({ error: 'forbidden', reason }), {
    status: 403,
    statusText: 'Forbidden',
    headers: { 'content-type': 'application/json' },
  })
}

export function can(actor: Actor, grants: Grant[], req: PermissionRequest): boolean {
  const ability = `${req.resource}:${req.action}` as Ability

  // The baseline is consulted first and a grant is only ever consulted after it
  // said no. That ordering is what makes "additive only" structural instead of
  // a rule somebody has to remember.
  const baseline = BASELINE[actor.role]
  if (baseline && baseline.has(ability)) return true

  const domainId = req.domainId ?? null
  return grants.some(
    (grant) =>
      grant.resource === req.resource &&
      grant.action === req.action &&
      (grant.scopeDomainId === null || grant.scopeDomainId === domainId)
  )
}

type GrantRow = {
  resource: Resource
  action: Action
  scope_domain_id: string | null
}

export async function loadGrants(userId: string): Promise<Grant[]> {
  const rows = await query<GrantRow>(
    `SELECT resource, action, scope_domain_id
       FROM grants
      WHERE user_id = $1
      ORDER BY resource, action, scope_domain_id NULLS FIRST`,
    [userId]
  )
  return rows.map((row) => ({
    resource: row.resource,
    action: row.action,
    scopeDomainId: row.scope_domain_id,
  }))
}

// Throws a Response rather than an Error so a route or server action can let it
// propagate: React Router renders a thrown Response as the response itself,
// which keeps a denied request from ever reaching the handler body.
export async function requirePermission(user: Actor, req: PermissionRequest): Promise<void> {
  const grants = await loadGrants(user.id)
  if (can(user, grants, req)) return
  throw forbidden(`${req.action} on ${req.resource} is not allowed`)
}

// Ownership is transferred by an explicit, audited action, never as a side
// effect of an admin editing a user row.
export function assertNotOwnerDemotion(actor: Actor, target: { role: Role }): void {
  if (target.role !== 'owner') return
  if (actor.role === 'owner') return
  throw forbidden('only an owner can change the owner account')
}
