import assert from 'node:assert/strict'
import { after, before, describe, it, test } from 'node:test'
import {
  ACTIONS,
  RESOURCES,
  ROLES,
  assertNotOwnerDemotion,
  assertOwnerTransitionAllowed,
  assertCanDeleteUser,
  can,
  loadGrants,
  requirePermission,
} from '../app/lib/permission.server.ts'
import type { Actor, Grant, PermissionRequest } from '../app/lib/permission.server.ts'
import { closePool } from '../app/lib/db.server.ts'

// The shared database helpers live in a sibling workspace of plain ESM
// JavaScript that this tsconfig does not cover, so a literal specifier would
// fail `tsc --noEmit` while working perfectly at runtime. Resolving through a
// URL keeps the typecheck honest without a stub declaration file.
const { freshDatabase, TEST_URL } = await import(
  new URL('../../db/test-support/helpers.mjs', import.meta.url).href
)
const { migrate } = await import(new URL('../../db/migrate.mjs', import.meta.url).href)

const SCHEMA = 'permission_model_test'

const ACTOR_ID = '00000000-0000-0000-0000-0000000000aa'
const DOMAIN_A = '11111111-1111-1111-1111-111111111111'
const DOMAIN_B = '22222222-2222-2222-2222-222222222222'

let db: { pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }; end: () => Promise<void> }

const users: Record<string, string> = {}
const domains: Record<string, string> = {}

async function seedUser(username: string, role: string): Promise<string> {
  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'not-a-real-hash', $3)
     RETURNING id`,
    [username, `${username}@example.com`, role]
  )
  return rows[0].id
}

async function seedDomain(apex: string): Promise<string> {
  const { rows } = await db.pool.query(
    'INSERT INTO domains (apex) VALUES ($1) RETURNING id',
    [apex]
  )
  return rows[0].id
}

async function seedGrant(
  userId: string,
  resource: string,
  action: string,
  scopeDomainId: string | null
): Promise<void> {
  await db.pool.query(
    'INSERT INTO grants (user_id, resource, action, scope_domain_id) VALUES ($1, $2, $3, $4)',
    [userId, resource, action, scopeDomainId]
  )
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  // db.server builds its own pool from the environment, so the test schema has
  // to reach it through the connection startup parameters rather than a SET.
  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`

  domains.a = await seedDomain('alpha.example')
  domains.b = await seedDomain('bravo.example')

  users.owner = await seedUser('olivia', 'owner')
  users.admin = await seedUser('adam', 'admin')
  users.editor = await seedUser('edith', 'editor')
  users.viewer = await seedUser('victor', 'viewer')
  users.scopedViewer = await seedUser('vera', 'viewer')
  users.globalViewer = await seedUser('vince', 'viewer')

  await seedGrant(users.scopedViewer, 'link', 'create', domains.a)
  await seedGrant(users.scopedViewer, 'link', 'update', domains.a)
  await seedGrant(users.globalViewer, 'link', 'delete', null)
})

after(async () => {
  await closePool()
  await db.end()
})

describe('role baseline', () => {
  it('owner may perform every action on every resource', () => {
    const owner: Actor = { id: ACTOR_ID, role: 'owner' }
    assert.equal(can(owner, [], { resource: 'domain', action: 'create' }), true)
    assert.equal(can(owner, [], { resource: 'domain', action: 'read' }), true)
    assert.equal(can(owner, [], { resource: 'domain', action: 'update' }), true)
    assert.equal(can(owner, [], { resource: 'domain', action: 'delete' }), true)
    assert.equal(can(owner, [], { resource: 'subdomain', action: 'create' }), true)
    assert.equal(can(owner, [], { resource: 'subdomain', action: 'read' }), true)
    assert.equal(can(owner, [], { resource: 'subdomain', action: 'update' }), true)
    assert.equal(can(owner, [], { resource: 'subdomain', action: 'delete' }), true)
    assert.equal(can(owner, [], { resource: 'link', action: 'create' }), true)
    assert.equal(can(owner, [], { resource: 'link', action: 'read' }), true)
    assert.equal(can(owner, [], { resource: 'link', action: 'update' }), true)
    assert.equal(can(owner, [], { resource: 'link', action: 'delete' }), true)
  })

  it('admin may perform every action on every resource', () => {
    const admin: Actor = { id: ACTOR_ID, role: 'admin' }
    assert.equal(can(admin, [], { resource: 'domain', action: 'create' }), true)
    assert.equal(can(admin, [], { resource: 'domain', action: 'read' }), true)
    assert.equal(can(admin, [], { resource: 'domain', action: 'update' }), true)
    assert.equal(can(admin, [], { resource: 'domain', action: 'delete' }), true)
    assert.equal(can(admin, [], { resource: 'subdomain', action: 'create' }), true)
    assert.equal(can(admin, [], { resource: 'subdomain', action: 'read' }), true)
    assert.equal(can(admin, [], { resource: 'subdomain', action: 'update' }), true)
    assert.equal(can(admin, [], { resource: 'subdomain', action: 'delete' }), true)
    assert.equal(can(admin, [], { resource: 'link', action: 'create' }), true)
    assert.equal(can(admin, [], { resource: 'link', action: 'read' }), true)
    assert.equal(can(admin, [], { resource: 'link', action: 'update' }), true)
    assert.equal(can(admin, [], { resource: 'link', action: 'delete' }), true)
  })

  it('editor has full CRUD on link and read-only on domain and subdomain', () => {
    const editor: Actor = { id: ACTOR_ID, role: 'editor' }
    assert.equal(can(editor, [], { resource: 'domain', action: 'create' }), false)
    assert.equal(can(editor, [], { resource: 'domain', action: 'read' }), true)
    assert.equal(can(editor, [], { resource: 'domain', action: 'update' }), false)
    assert.equal(can(editor, [], { resource: 'domain', action: 'delete' }), false)
    assert.equal(can(editor, [], { resource: 'subdomain', action: 'create' }), false)
    assert.equal(can(editor, [], { resource: 'subdomain', action: 'read' }), true)
    assert.equal(can(editor, [], { resource: 'subdomain', action: 'update' }), false)
    assert.equal(can(editor, [], { resource: 'subdomain', action: 'delete' }), false)
    assert.equal(can(editor, [], { resource: 'link', action: 'create' }), true)
    assert.equal(can(editor, [], { resource: 'link', action: 'read' }), true)
    assert.equal(can(editor, [], { resource: 'link', action: 'update' }), true)
    assert.equal(can(editor, [], { resource: 'link', action: 'delete' }), true)
  })

  it('viewer may only read', () => {
    const viewer: Actor = { id: ACTOR_ID, role: 'viewer' }
    assert.equal(can(viewer, [], { resource: 'domain', action: 'create' }), false)
    assert.equal(can(viewer, [], { resource: 'domain', action: 'read' }), true)
    assert.equal(can(viewer, [], { resource: 'domain', action: 'update' }), false)
    assert.equal(can(viewer, [], { resource: 'domain', action: 'delete' }), false)
    assert.equal(can(viewer, [], { resource: 'subdomain', action: 'create' }), false)
    assert.equal(can(viewer, [], { resource: 'subdomain', action: 'read' }), true)
    assert.equal(can(viewer, [], { resource: 'subdomain', action: 'update' }), false)
    assert.equal(can(viewer, [], { resource: 'subdomain', action: 'delete' }), false)
    assert.equal(can(viewer, [], { resource: 'link', action: 'create' }), false)
    assert.equal(can(viewer, [], { resource: 'link', action: 'read' }), true)
    assert.equal(can(viewer, [], { resource: 'link', action: 'update' }), false)
    assert.equal(can(viewer, [], { resource: 'link', action: 'delete' }), false)
  })

  it('the role baseline is the same in every domain', () => {
    const editor: Actor = { id: ACTOR_ID, role: 'editor' }
    assert.equal(can(editor, [], { resource: 'link', action: 'update', domainId: DOMAIN_A }), true)
    assert.equal(can(editor, [], { resource: 'link', action: 'update', domainId: DOMAIN_B }), true)
    assert.equal(can(editor, [], { resource: 'link', action: 'update', domainId: null }), true)
    assert.equal(can(editor, [], { resource: 'domain', action: 'delete', domainId: DOMAIN_A }), false)
    assert.equal(can(editor, [], { resource: 'domain', action: 'delete', domainId: DOMAIN_B }), false)
  })
})

describe('grants are additive', () => {
  const viewer: Actor = { id: ACTOR_ID, role: 'viewer' }
  const createInA: Grant = { resource: 'link', action: 'create', scopeDomainId: DOMAIN_A }
  const createAnywhere: Grant = { resource: 'link', action: 'create', scopeDomainId: null }

  it('a scoped grant applies only inside its own domain', () => {
    assert.equal(can(viewer, [createInA], { resource: 'link', action: 'create', domainId: DOMAIN_A }), true)
    assert.equal(can(viewer, [createInA], { resource: 'link', action: 'create', domainId: DOMAIN_B }), false)
  })

  it('a scoped grant stays inert when the request names no domain', () => {
    assert.equal(can(viewer, [createInA], { resource: 'link', action: 'create' }), false)
    assert.equal(can(viewer, [createInA], { resource: 'link', action: 'create', domainId: null }), false)
  })

  it('an unscoped grant applies to every domain', () => {
    assert.equal(can(viewer, [createAnywhere], { resource: 'link', action: 'create', domainId: DOMAIN_A }), true)
    assert.equal(can(viewer, [createAnywhere], { resource: 'link', action: 'create', domainId: DOMAIN_B }), true)
  })

  it('an unscoped grant applies when the request names no domain', () => {
    assert.equal(can(viewer, [createAnywhere], { resource: 'link', action: 'create' }), true)
    assert.equal(can(viewer, [createAnywhere], { resource: 'link', action: 'create', domainId: null }), true)
  })

  it('a grant on another resource does not widen the requested one', () => {
    const domainCreate: Grant = { resource: 'domain', action: 'create', scopeDomainId: null }
    assert.equal(can(viewer, [domainCreate], { resource: 'link', action: 'create' }), false)
    assert.equal(can(viewer, [domainCreate], { resource: 'subdomain', action: 'create' }), false)
    assert.equal(can(viewer, [domainCreate], { resource: 'domain', action: 'create' }), true)
  })

  it('a grant on another action does not widen the requested one', () => {
    const linkDelete: Grant = { resource: 'link', action: 'delete', scopeDomainId: null }
    assert.equal(can(viewer, [linkDelete], { resource: 'link', action: 'create' }), false)
    assert.equal(can(viewer, [linkDelete], { resource: 'link', action: 'update' }), false)
    assert.equal(can(viewer, [linkDelete], { resource: 'link', action: 'delete' }), true)
  })

  it('several scoped grants accumulate instead of competing', () => {
    const createInB: Grant = { resource: 'link', action: 'create', scopeDomainId: DOMAIN_B }
    const both = [createInA, createInB]
    assert.equal(can(viewer, both, { resource: 'link', action: 'create', domainId: DOMAIN_A }), true)
    assert.equal(can(viewer, both, { resource: 'link', action: 'create', domainId: DOMAIN_B }), true)
  })

  it('holding a create grant leaves the baseline read intact', () => {
    assert.equal(can(viewer, [createInA], { resource: 'link', action: 'read', domainId: DOMAIN_B }), true)
    assert.equal(can(viewer, [createInA], { resource: 'domain', action: 'read', domainId: DOMAIN_B }), true)
    assert.equal(can(viewer, [createInA], { resource: 'subdomain', action: 'read', domainId: DOMAIN_B }), true)
  })

  it('no grant can remove an ability the role already allows', () => {
    const scopes: (string | null)[] = [null, DOMAIN_A, DOMAIN_B]
    const candidates: Grant[] = []
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        for (const scopeDomainId of scopes) {
          candidates.push({ resource, action, scopeDomainId })
        }
      }
    }

    for (const role of ROLES) {
      const actor: Actor = { id: ACTOR_ID, role }
      for (const resource of RESOURCES) {
        for (const action of ACTIONS) {
          for (const domainId of scopes) {
            const req: PermissionRequest = { resource, action, domainId }
            if (!can(actor, [], req)) continue
            for (const grant of candidates) {
              assert.equal(
                can(actor, [grant], req),
                true,
                `${role} lost ${resource}:${action} in ${domainId ?? 'any domain'} because of a ` +
                  `${grant.resource}:${grant.action} grant scoped to ${grant.scopeDomainId ?? 'every domain'}`
              )
            }
          }
        }
      }
    }
  })
})

describe('loadGrants', () => {
  it('returns an empty list for a user holding no grants', async () => {
    assert.deepEqual(await loadGrants(users.viewer), [])
  })

  it('returns the scoped grants of one user', async () => {
    const grants = await loadGrants(users.scopedViewer)
    assert.equal(grants.length, 2)
    assert.deepEqual(grants, [
      { resource: 'link', action: 'create', scopeDomainId: domains.a },
      { resource: 'link', action: 'update', scopeDomainId: domains.a },
    ])
  })

  it('returns an unscoped grant with a null scope', async () => {
    assert.deepEqual(await loadGrants(users.globalViewer), [
      { resource: 'link', action: 'delete', scopeDomainId: null },
    ])
  })

  it('ignores grants belonging to another user', async () => {
    const grants = await loadGrants(users.admin)
    assert.deepEqual(grants, [])
  })
})

describe('requirePermission', () => {
  async function capture(promise: Promise<void>): Promise<unknown> {
    return promise.then(
      () => null,
      (err: unknown) => err
    )
  }

  it('resolves when the role alone allows the request', async () => {
    const owner: Actor = { id: users.owner, role: 'owner' }
    assert.equal(await capture(requirePermission(owner, { resource: 'domain', action: 'delete' })), null)
  })

  it('resolves when a stored grant allows the request', async () => {
    const vera: Actor = { id: users.scopedViewer, role: 'viewer' }
    assert.equal(
      await capture(requirePermission(vera, { resource: 'link', action: 'create', domainId: domains.a })),
      null
    )
  })

  it('throws a Response with status 403 rather than a plain Error', async () => {
    const viewer: Actor = { id: users.viewer, role: 'viewer' }
    const err = await capture(requirePermission(viewer, { resource: 'link', action: 'delete' }))
    assert.ok(err instanceof Response, 'expected a thrown Response')
    assert.equal(err.status, 403)
    assert.equal(err instanceof Error, false)
  })

  it('denies a scoped grant used outside its domain', async () => {
    const vera: Actor = { id: users.scopedViewer, role: 'viewer' }
    const err = await capture(
      requirePermission(vera, { resource: 'link', action: 'create', domainId: domains.b })
    )
    assert.ok(err instanceof Response)
    assert.equal(err.status, 403)
  })
})

describe('owner protection', () => {
  const owner = { role: 'owner' } as const
  const editorTarget = { role: 'editor' } as const

  it('rejects an admin acting on the owner', () => {
    const admin: Actor = { id: ACTOR_ID, role: 'admin' }
    try {
      assertNotOwnerDemotion(admin, owner)
      assert.fail('expected a thrown Response')
    } catch (err) {
      assert.ok(err instanceof Response)
      assert.equal(err.status, 403)
    }
  })

  it('rejects an editor and a viewer acting on the owner', () => {
    for (const role of ['editor', 'viewer'] as const) {
      try {
        assertNotOwnerDemotion({ id: ACTOR_ID, role }, owner)
        assert.fail(`expected a thrown Response for ${role}`)
      } catch (err) {
        assert.ok(err instanceof Response, `${role} should be refused with a Response`)
        assert.equal(err.status, 403)
      }
    }
  })

  it('allows the owner to act on the owner', () => {
    const actor: Actor = { id: ACTOR_ID, role: 'owner' }
    assert.equal(assertNotOwnerDemotion(actor, owner), undefined)
  })

  it('allows every role to act on a target that is not the owner', () => {
    for (const role of ROLES) {
      assert.equal(assertNotOwnerDemotion({ id: ACTOR_ID, role }, editorTarget), undefined)
    }
  })
})

// ── owner transition guards ─────────────────────────────────────────────────
// Added after an adversarial review found that guarding only the target's
// current role blocked demotion while leaving promotion wide open.

test('an admin cannot promote anyone to owner, including themselves', () => {
  const admin: Actor = { id: 'admin-1', role: 'admin' }

  assert.throws(
    () => assertOwnerTransitionAllowed(admin, { id: 'admin-1', role: 'admin' }, 'owner'),
    (err: unknown) => err instanceof Response && err.status === 403
  )
  assert.throws(
    () => assertOwnerTransitionAllowed(admin, { id: 'editor-1', role: 'editor' }, 'owner'),
    (err: unknown) => err instanceof Response && err.status === 403
  )
})

test('an admin cannot demote the owner', () => {
  const admin: Actor = { id: 'admin-1', role: 'admin' }
  assert.throws(
    () => assertOwnerTransitionAllowed(admin, { id: 'owner-1', role: 'owner' }, 'viewer'),
    (err: unknown) => err instanceof Response && err.status === 403
  )
})

test('an owner may grant and remove ownership', () => {
  const owner: Actor = { id: 'owner-1', role: 'owner' }
  assert.doesNotThrow(() =>
    assertOwnerTransitionAllowed(owner, { id: 'admin-1', role: 'admin' }, 'owner')
  )
  assert.doesNotThrow(() =>
    assertOwnerTransitionAllowed(owner, { id: 'owner-2', role: 'owner' }, 'admin')
  )
})

test('a transition that never touches owner is not this guard business', () => {
  const admin: Actor = { id: 'admin-1', role: 'admin' }
  assert.doesNotThrow(() =>
    assertOwnerTransitionAllowed(admin, { id: 'v-1', role: 'viewer' }, 'editor')
  )
})

test('an admin cannot delete the owner, and an owner cannot delete themselves', () => {
  const admin: Actor = { id: 'admin-1', role: 'admin' }
  const owner: Actor = { id: 'owner-1', role: 'owner' }

  assert.throws(
    () => assertCanDeleteUser(admin, { id: 'owner-1', role: 'owner' }),
    (err: unknown) => err instanceof Response && err.status === 403
  )
  assert.throws(
    () => assertCanDeleteUser(owner, { id: 'owner-1', role: 'owner' }),
    (err: unknown) => err instanceof Response && err.status === 403,
    'self-deletion would leave the installation unadministrable'
  )
  assert.doesNotThrow(() => assertCanDeleteUser(admin, { id: 'e-1', role: 'editor' }))
})

test('the user resource exists and only owner and admin hold it', () => {
  assert.ok(RESOURCES.includes('user'), 'user administration must be expressible')

  for (const action of ACTIONS) {
    const req = { resource: 'user' as const, action }
    assert.equal(can({ id: 'o', role: 'owner' }, [], req), true)
    assert.equal(can({ id: 'a', role: 'admin' }, [], req), true)
    assert.equal(can({ id: 'e', role: 'editor' }, [], req), false)
    assert.equal(can({ id: 'v', role: 'viewer' }, [], req), false)
  }
})

test('the ability table covers every resource and action, with no gap', () => {
  // Asserted against the enums rather than a hand-written list: a resource added
  // without a baseline decision fails here instead of defaulting to denied and
  // being discovered by a confused user.
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      assert.equal(
        can({ id: 'o', role: 'owner' }, [], { resource, action }),
        true,
        `owner must hold ${resource}:${action}`
      )
    }
  }
})
