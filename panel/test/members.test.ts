import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import {
  addGrant,
  changeRole,
  createInvite,
  listGrants,
  listMembers,
  listPendingInvites,
  redeemInvite,
  removeGrant,
  removeMember,
  revokeInvite,
  setStatus,
} from '../app/lib/members.server.ts'
import { can, loadGrants, type Actor } from '../app/lib/permission.server.ts'
import { closePool } from '../app/lib/db.server.ts'

// The db workspace is plain ESM with no type declarations and the panel's
// tsconfig does not compile JavaScript. A computed specifier keeps `tsc
// --noEmit` from typing a module it cannot see.
const load = (path: string) => import(new URL(path, import.meta.url).href)

const { freshDatabase, TEST_URL } = (await load('../../db/test-support/helpers.mjs')) as {
  freshDatabase: (schemaName: string) => Promise<TestDatabase>
  TEST_URL: string
}
const { migrate } = (await load('../../db/migrate.mjs')) as {
  migrate: (pool: Pool, dir?: string) => Promise<string[]>
}

type TestDatabase = { pool: Pool; schemaName: string; end: () => Promise<void> }

const SCHEMA = 'members_layer_test'

const PASSPHRASE = 'a-long-enough-passphrase'

let db: TestDatabase

const user: Record<string, string> = {}
const domain: Record<string, string> = {}

/** A 403 thrown by the permission layer arrives as a Response, not an Error. */
function isForbidden(thrown: unknown): true {
  assert.ok(thrown instanceof Response, `expected a Response, got ${String(thrown)}`)
  assert.equal(thrown.status, 403)
  return true
}

async function seedUser(username: string, role: string, status = 'active'): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role, status)
     VALUES ($1, $2, 'not-a-real-hash', $3, $4)
     RETURNING id`,
    [username, `${username}@example.com`, role, status]
  )
  return rows[0].id
}

async function seedDomain(apex: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    'INSERT INTO domains (apex) VALUES ($1) RETURNING id',
    [apex]
  )
  return rows[0].id
}

async function roleOf(id: string): Promise<string | null> {
  const { rows } = await db.pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [id])
  return rows[0]?.role ?? null
}

async function statusOf(id: string): Promise<string | null> {
  const { rows } = await db.pool.query<{ status: string }>(
    'SELECT status FROM users WHERE id = $1',
    [id]
  )
  return rows[0]?.status ?? null
}

async function auditCount(action: string, entityId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND entity_id = $2`,
    [action, entityId]
  )
  return rows[0].n
}

/** Reset the cast to a known set before each test, so order never matters. */
async function reseed(): Promise<void> {
  await db.pool.query('DELETE FROM invites')
  await db.pool.query('DELETE FROM audit_log')
  await db.pool.query('DELETE FROM links')
  await db.pool.query('DELETE FROM grants')
  await db.pool.query('DELETE FROM users')

  user.owner = await seedUser('olivia', 'owner')
  user.admin = await seedUser('adam', 'admin')
  user.editor = await seedUser('edith', 'editor')
  user.viewer = await seedUser('victor', 'viewer')
}

const owner = (): Actor => ({ id: user.owner, role: 'owner' })
const admin = (): Actor => ({ id: user.admin, role: 'admin' })
const editor = (): Actor => ({ id: user.editor, role: 'editor' })

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  // db.server builds its own pool from the environment, so the test schema has
  // to reach it through the connection startup parameters rather than a SET.
  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`

  domain.a = await seedDomain('alpha.example')
  domain.b = await seedDomain('bravo.example')
})

beforeEach(reseed)

after(async () => {
  await closePool()
  await db.end()
})

// ------------------------------------------------------------------ listing

describe('listMembers', () => {
  it('returns every account with its role, status, and last seen', async () => {
    await db.pool.query(
      `UPDATE users SET last_seen_at = timestamptz '2026-05-01 10:00+00' WHERE id = $1`,
      [user.editor]
    )

    const rows = await listMembers()
    assert.equal(rows.length, 4)

    const edith = rows.find((row) => row.username === 'edith')
    assert.ok(edith)
    assert.equal(edith.role, 'editor')
    assert.equal(edith.status, 'active')
    assert.equal(edith.email, 'edith@example.com')
    assert.ok(edith.lastSeenAt instanceof Date)

    const victor = rows.find((row) => row.username === 'victor')
    assert.equal(victor?.lastSeenAt, null)
  })

  it('puts the owner first, because the list is an org chart before it is an index', async () => {
    const rows = await listMembers()
    assert.equal(rows[0].role, 'owner')
    assert.deepEqual(
      rows.map((row) => row.role),
      ['owner', 'admin', 'editor', 'viewer']
    )
  })

  it('counts the live links each member created', async () => {
    const { rows: sub } = await db.pool.query<{ id: string }>(
      `INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.alpha.example') RETURNING id`,
      [domain.a]
    )
    await db.pool.query(
      `INSERT INTO links (subdomain_id, slug, target_url, created_by)
       VALUES ($1, 'promo', 'https://example.com/a', $2),
              ($1, 'sale',  'https://example.com/b', $2)`,
      [sub[0].id, user.editor]
    )

    const rows = await listMembers()
    assert.equal(rows.find((row) => row.username === 'edith')?.linksCreated, 2)
    assert.equal(rows.find((row) => row.username === 'adam')?.linksCreated, 0)
  })
})

// --------------------------------------------------------------- role change

describe('changeRole', () => {
  it('refuses an admin promoting themselves to owner', async () => {
    // The hole assertOwnerTransitionAllowed exists to close: an admin who could
    // only be stopped from demoting the owner would simply take the seat instead.
    await assert.rejects(() => changeRole(admin(), user.admin, 'owner'), isForbidden)
    assert.equal(await roleOf(user.admin), 'admin')
  })

  it('refuses an admin promoting anyone else to owner', async () => {
    await assert.rejects(() => changeRole(admin(), user.editor, 'owner'), isForbidden)
    assert.equal(await roleOf(user.editor), 'editor')
  })

  it('refuses an admin demoting the owner', async () => {
    await assert.rejects(() => changeRole(admin(), user.owner, 'admin'), isForbidden)
    assert.equal(await roleOf(user.owner), 'owner')
  })

  it('refuses an editor changing anybody', async () => {
    await assert.rejects(() => changeRole(editor(), user.viewer, 'admin'), isForbidden)
    assert.equal(await roleOf(user.viewer), 'viewer')
  })

  it('lets an admin promote an editor, and records the change', async () => {
    await changeRole(admin(), user.editor, 'admin')
    assert.equal(await roleOf(user.editor), 'admin')
    assert.equal(await auditCount('user.role', user.editor), 1)
  })

  it('transfers ownership in one step, leaving exactly one owner', async () => {
    await changeRole(owner(), user.admin, 'owner')

    assert.equal(await roleOf(user.admin), 'owner')
    // The previous owner steps down in the same transaction. Two owners means
    // two people who can delete each other, and the owner guards stop guarding
    // anything.
    assert.equal(await roleOf(user.owner), 'admin')

    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE role = 'owner'`
    )
    assert.equal(rows[0].n, 1)
  })

  it('refuses to demote the only owner', async () => {
    await assert.rejects(() => changeRole(owner(), user.owner, 'admin'), isForbidden)
    assert.equal(await roleOf(user.owner), 'owner')
  })
})

// ------------------------------------------------------------------- status

describe('setStatus', () => {
  it('refuses an admin suspending the owner', async () => {
    // Suspension is demotion by another name: it strips every ability the role
    // carried, so it answers to the same guard.
    await assert.rejects(() => setStatus(admin(), user.owner, 'suspended'), isForbidden)
    assert.equal(await statusOf(user.owner), 'active')
  })

  it('refuses an owner suspending their own account', async () => {
    await assert.rejects(() => setStatus(owner(), user.owner, 'suspended'), isForbidden)
    assert.equal(await statusOf(user.owner), 'active')
  })

  it('refuses an editor suspending anybody', async () => {
    await assert.rejects(() => setStatus(editor(), user.viewer, 'suspended'), isForbidden)
    assert.equal(await statusOf(user.viewer), 'active')
  })

  it('lets an admin suspend and restore an editor', async () => {
    await setStatus(admin(), user.editor, 'suspended')
    assert.equal(await statusOf(user.editor), 'suspended')
    assert.equal(
      (await listMembers()).find((row) => row.username === 'edith')?.status,
      'suspended'
    )

    await setStatus(admin(), user.editor, 'active')
    assert.equal(await statusOf(user.editor), 'active')
    assert.equal(await auditCount('user.status', user.editor), 2)
  })
})

// ------------------------------------------------------------------ removal

describe('removeMember', () => {
  it('refuses an admin removing the owner', async () => {
    // Without assertCanDeleteUser an admin reaches the same place by a different
    // door: user:delete sits in the admin baseline.
    await assert.rejects(() => removeMember(admin(), user.owner), isForbidden)
    assert.equal(await roleOf(user.owner), 'owner')
  })

  it('refuses an owner removing their own account', async () => {
    await assert.rejects(() => removeMember(owner(), user.owner), isForbidden)
    assert.equal(await roleOf(user.owner), 'owner')
  })

  it('refuses an editor removing anybody', async () => {
    await assert.rejects(() => removeMember(editor(), user.viewer), isForbidden)
    assert.equal(await roleOf(user.viewer), 'viewer')
  })

  it('removes an account and leaves the links it created standing', async () => {
    const { rows: sub } = await db.pool.query<{ id: string }>(
      `INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.bravo.example') RETURNING id`,
      [domain.b]
    )
    await db.pool.query(
      `INSERT INTO links (subdomain_id, slug, target_url, created_by)
       VALUES ($1, 'launch', 'https://example.com/launch', $2)`,
      [sub[0].id, user.editor]
    )

    await removeMember(admin(), user.editor)

    assert.equal(await roleOf(user.editor), null)
    const { rows } = await db.pool.query<{ created_by: string | null }>(
      `SELECT created_by FROM links WHERE slug = 'launch'`
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].created_by, null)
    assert.equal(await auditCount('user.remove', user.editor), 1)
  })
})

// ------------------------------------------------------------------ invites

describe('createInvite', () => {
  it('stores only a digest of the token', async () => {
    const invite = await createInvite(admin(), { email: 'nova@example.com', role: 'editor' })

    const { rows } = await db.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM invites WHERE lower(email) = $1',
      ['nova@example.com']
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].token_hash, createHash('sha256').update(invite.token).digest('hex'))

    // A dump that yields the raw token yields a working account.
    const { rows: leaked } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM invites WHERE token_hash = $1`,
      [invite.token]
    )
    assert.equal(leaked[0].n, 0)
  })

  it('builds a copyable URL carrying the token', async () => {
    const invite = await createInvite(admin(), {
      email: 'nova@example.com',
      role: 'viewer',
      origin: 'https://panel.example',
    })
    assert.equal(invite.url, `https://panel.example/join?token=${invite.token}`)
    assert.ok(invite.expiresAt.getTime() > Date.now())
  })

  it('refuses to invite an owner', async () => {
    // Ownership is transferred by an explicit, audited action against an account
    // that already exists — never handed to whoever opens a link.
    await assert.rejects(
      () => createInvite(owner(), { email: 'nova@example.com', role: 'owner' as never }),
      isForbidden
    )
  })

  it('refuses an editor inviting anybody', async () => {
    await assert.rejects(
      () => createInvite(editor(), { email: 'nova@example.com', role: 'viewer' }),
      isForbidden
    )
  })

  it('replaces an outstanding invite for the same address', async () => {
    const first = await createInvite(admin(), { email: 'nova@example.com', role: 'viewer' })
    const second = await createInvite(admin(), { email: 'NOVA@example.com', role: 'editor' })

    const pending = await listPendingInvites()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].role, 'editor')

    // The superseded token stops working the moment the new one is issued.
    assert.deepEqual(await redeemInvite(first.token, { username: 'nova', password: PASSPHRASE }), {
      ok: false,
      problem: 'revoked',
    })
    const taken = await redeemInvite(second.token, { username: 'nova', password: PASSPHRASE })
    assert.equal(taken.ok, true)
  })

  it('lets an admin revoke a pending invite', async () => {
    const invite = await createInvite(admin(), { email: 'nova@example.com', role: 'viewer' })
    const [pending] = await listPendingInvites()

    await revokeInvite(admin(), pending.id)

    assert.deepEqual(await listPendingInvites(), [])
    assert.deepEqual(await redeemInvite(invite.token, { username: 'nova', password: PASSPHRASE }), {
      ok: false,
      problem: 'revoked',
    })
  })
})

describe('redeemInvite', () => {
  it('creates the account with the invited role and address', async () => {
    const invite = await createInvite(admin(), { email: 'Nova@Example.com', role: 'editor' })

    const result = await redeemInvite(invite.token, { username: 'nova', password: PASSPHRASE })
    assert.equal(result.ok, true)

    const { rows } = await db.pool.query<{ role: string; email: string; password_hash: string }>(
      'SELECT role, email, password_hash FROM users WHERE username = $1',
      ['nova']
    )
    assert.equal(rows[0].role, 'editor')
    // The address is the invite's, never the form's: the invite was issued to a
    // person, and letting the redeemer retype it makes the seat transferable.
    assert.equal(rows[0].email, 'Nova@Example.com')
    assert.match(rows[0].password_hash, /^\$argon2id\$/)
  })

  it('refuses an expired invite', async () => {
    const invite = await createInvite(admin(), { email: 'nova@example.com', role: 'viewer' })
    await db.pool.query(
      `UPDATE invites SET expires_at = now() - interval '1 hour' WHERE lower(email) = $1`,
      ['nova@example.com']
    )

    assert.deepEqual(await redeemInvite(invite.token, { username: 'nova', password: PASSPHRASE }), {
      ok: false,
      problem: 'expired',
    })
    assert.equal(await db.pool.query('SELECT 1 FROM users WHERE username = $1', ['nova']).then((r) => r.rowCount), 0)
  })

  it('refuses a second redemption of the same invite', async () => {
    const invite = await createInvite(admin(), { email: 'nova@example.com', role: 'viewer' })

    const first = await redeemInvite(invite.token, { username: 'nova', password: PASSPHRASE })
    assert.equal(first.ok, true)

    const second = await redeemInvite(invite.token, { username: 'nova2', password: PASSPHRASE })
    assert.deepEqual(second, { ok: false, problem: 'used' })

    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = 'nova@example.com'`
    )
    assert.equal(rows[0].n, 1)
  })

  it('refuses a token nobody issued', async () => {
    assert.deepEqual(await redeemInvite('not-a-token', { username: 'nova', password: PASSPHRASE }), {
      ok: false,
      problem: 'invalid',
    })
  })

  it('leaves the invite open when the chosen username is taken', async () => {
    const invite = await createInvite(admin(), { email: 'nova@example.com', role: 'viewer' })

    assert.deepEqual(await redeemInvite(invite.token, { username: 'adam', password: PASSPHRASE }), {
      ok: false,
      problem: 'taken',
    })

    // A failed redemption that burnt the invite would leave the person locked
    // out with a link that now says "already used".
    const retry = await redeemInvite(invite.token, { username: 'nova', password: PASSPHRASE })
    assert.equal(retry.ok, true)
  })

  it('refuses a password shorter than the policy', async () => {
    const invite = await createInvite(admin(), { email: 'nova@example.com', role: 'viewer' })
    assert.deepEqual(await redeemInvite(invite.token, { username: 'nova', password: 'short' }), {
      ok: false,
      problem: 'password',
    })
  })
})

// ------------------------------------------------------------------- grants

describe('grants', () => {
  it('widens the domain it names and no other', async () => {
    await addGrant(admin(), user.viewer, {
      resource: 'link',
      action: 'create',
      scopeDomainId: domain.a,
    })

    const actor: Actor = { id: user.viewer, role: 'viewer' }
    const grants = await loadGrants(user.viewer)

    assert.equal(can(actor, grants, { resource: 'link', action: 'create', domainId: domain.a }), true)
    assert.equal(can(actor, grants, { resource: 'link', action: 'create', domainId: domain.b }), false)
    // A scoped grant must not answer a question that names no domain either,
    // or every unscoped call site silently becomes an installation-wide yes.
    assert.equal(can(actor, grants, { resource: 'link', action: 'create' }), false)
    // And it widens only the ability it names.
    assert.equal(can(actor, grants, { resource: 'link', action: 'delete', domainId: domain.a }), false)
  })

  it('lists a grant with the domain it is scoped to', async () => {
    await addGrant(admin(), user.viewer, {
      resource: 'link',
      action: 'update',
      scopeDomainId: domain.a,
    })
    await addGrant(admin(), user.viewer, {
      resource: 'domain',
      action: 'update',
      scopeDomainId: null,
    })

    const rows = await listGrants(user.viewer)
    assert.equal(rows.length, 2)
    const scoped = rows.find((row) => row.resource === 'link')
    assert.equal(scoped?.domainApex, 'alpha.example')
    const everywhere = rows.find((row) => row.resource === 'domain')
    assert.equal(everywhere?.scopeDomainId, null)
    assert.equal(everywhere?.domainApex, null)
  })

  it('is idempotent, and removal takes the ability back', async () => {
    const grant = { resource: 'link', action: 'create', scopeDomainId: domain.a } as const
    await addGrant(admin(), user.viewer, grant)
    await addGrant(admin(), user.viewer, grant)
    assert.equal((await listGrants(user.viewer)).length, 1)

    await removeGrant(admin(), user.viewer, grant)
    assert.deepEqual(await listGrants(user.viewer), [])
  })

  it('refuses a grant over accounts', async () => {
    // The grants table has no `user` member on purpose: an account belongs to
    // the installation, not to a domain, so "user:delete inside alpha.example"
    // has no meaning to check against.
    await assert.rejects(
      () =>
        addGrant(admin(), user.viewer, {
          resource: 'user' as never,
          action: 'delete',
          scopeDomainId: domain.a,
        }),
      isForbidden
    )
  })

  it('refuses an editor handing out abilities', async () => {
    await assert.rejects(
      () =>
        addGrant(editor(), user.viewer, {
          resource: 'link',
          action: 'create',
          scopeDomainId: domain.a,
        }),
      isForbidden
    )
  })
})
