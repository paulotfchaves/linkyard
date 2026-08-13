import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate, MIGRATIONS_DIR } from '../migrate.mjs'
import { freshDatabase } from '../test-support/helpers.mjs'

async function migratedDatabase(schemaName) {
  const db = await freshDatabase(schemaName)
  await migrate(db.pool, MIGRATIONS_DIR)
  return db
}

test('users: email is unique and case-insensitive', async (t) => {
  const db = await migratedDatabase('schema_users')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('ana', 'Ana@Example.com', 'x', 'owner')`
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ('ana2', 'ana@example.com', 'x', 'admin')`
      ),
    /duplicate key/
  )
})

test('users: role is constrained to the four known roles', async (t) => {
  const db = await migratedDatabase('schema_roles')
  t.after(() => db.end())

  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ('x', 'x@example.com', 'x', 'superuser')`
      ),
    /users_role_check/
  )
})

test('users: timezone defaults to UTC and locale to en', async (t) => {
  const db = await migratedDatabase('schema_defaults')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('x', 'x@example.com', 'x', 'owner')
     RETURNING timezone, locale, status`
  )
  assert.equal(rows[0].timezone, 'UTC')
  assert.equal(rows[0].locale, 'en')
  assert.equal(rows[0].status, 'active')
})

test('sessions: cascade-delete with the user', async (t) => {
  const db = await migratedDatabase('schema_sessions')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('x', 'x@example.com', 'x', 'owner') RETURNING id`
  )
  const userId = rows[0].id
  await db.pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, 'hash', now() + interval '1 day')`,
    [userId]
  )
  await db.pool.query('DELETE FROM users WHERE id = $1', [userId])
  const { rows: left } = await db.pool.query('SELECT count(*)::int AS n FROM sessions')
  assert.equal(left[0].n, 0)
})

test('grants: resource and action are constrained', async (t) => {
  const db = await migratedDatabase('schema_grants')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ('x', 'x@example.com', 'x', 'viewer') RETURNING id`
  )
  const userId = rows[0].id

  await db.pool.query(
    `INSERT INTO grants (user_id, resource, action) VALUES ($1, 'link', 'create')`,
    [userId]
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO grants (user_id, resource, action) VALUES ($1, 'billing', 'create')`,
        [userId]
      ),
    /grants_resource_check/
  )
})

test('settings: key is the primary key and value is jsonb', async (t) => {
  const db = await migratedDatabase('schema_settings')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO settings (key, value) VALUES ('probe_number', '180'::jsonb)`
  )
  const { rows } = await db.pool.query(
    `SELECT value FROM settings WHERE key = 'probe_number'`
  )
  assert.equal(rows[0].value, 180)
})

// ── infrastructure ──────────────────────────────────────────────────────────

test('credentials: only ciphertext is stored, never a plaintext column', async (t) => {
  const db = await migratedDatabase('schema_creds')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'schema_creds' AND table_name = 'credentials'
      ORDER BY column_name`
  )
  const cols = rows.map((r) => r.column_name)
  assert.ok(cols.includes('ciphertext'), 'ciphertext column must exist')
  for (const forbidden of ['token', 'plaintext', 'secret', 'value']) {
    assert.ok(!cols.includes(forbidden), `credentials must not have a "${forbidden}" column`)
  }
})

test('credentials: one row per provider and label', async (t) => {
  const db = await migratedDatabase('schema_creds_unique')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO credentials (provider, label, ciphertext, last4)
     VALUES ('cloudflare', 'main', '\\x00'::bytea, 'ab12')`
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO credentials (provider, label, ciphertext, last4)
         VALUES ('cloudflare', 'main', '\\x01'::bytea, 'cd34')`
      ),
    /duplicate key/
  )
})

test('domains: root_policy is constrained and custom_url needs a target', async (t) => {
  const db = await migratedDatabase('schema_domains')
  t.after(() => db.end())

  await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex')`
  )
  await assert.rejects(
    () => db.pool.query(`INSERT INTO domains (apex, root_policy) VALUES ('b.com', 'four_oh_four')`),
    /domains_root_policy_check/
  )
  await assert.rejects(
    () => db.pool.query(`INSERT INTO domains (apex, root_policy) VALUES ('c.com', 'custom_url')`),
    /domains_custom_url_needs_target/
  )
})

test('subdomains: host is globally unique and cascades from its domain', async (t) => {
  const db = await migratedDatabase('schema_subdomains')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ('example.com', 'redirect_apex') RETURNING id`
  )
  const domainId = rows[0].id

  await db.pool.query(`INSERT INTO subdomains (domain_id, host) VALUES ($1, 'go.example.com')`, [
    domainId,
  ])
  await assert.rejects(
    () =>
      db.pool.query(`INSERT INTO subdomains (domain_id, host) VALUES ($1, 'GO.example.com')`, [
        domainId,
      ]),
    /duplicate key/
  )

  await db.pool.query('DELETE FROM domains WHERE id = $1', [domainId])
  const { rows: left } = await db.pool.query('SELECT count(*)::int AS n FROM subdomains')
  assert.equal(left[0].n, 0)
})

// ── links ───────────────────────────────────────────────────────────────────

async function seedSubdomain(pool, apex = 'example.com', host = 'go.example.com') {
  const { rows: d } = await pool.query(
    `INSERT INTO domains (apex, root_policy) VALUES ($1, 'redirect_apex') RETURNING id`,
    [apex]
  )
  const { rows: s } = await pool.query(
    `INSERT INTO subdomains (domain_id, host) VALUES ($1, $2) RETURNING id`,
    [d[0].id, host]
  )
  return s[0].id
}

test('links: slug is unique per subdomain but reusable across subdomains', async (t) => {
  const db = await migratedDatabase('schema_links')
  t.after(() => db.end())

  const subA = await seedSubdomain(db.pool)
  const subB = await seedSubdomain(db.pool, 'other.com', 'go.other.com')

  await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url) VALUES ($1, 'promo', 'https://a.example')`,
    [subA]
  )
  await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url) VALUES ($1, 'promo', 'https://b.example')`,
    [subB]
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO links (subdomain_id, slug, target_url) VALUES ($1, 'PROMO', 'https://c.example')`,
        [subA]
      ),
    /duplicate key/
  )
})

test('links: reserved slugs are rejected by the database', async (t) => {
  const db = await migratedDatabase('schema_reserved')
  t.after(() => db.end())
  const sub = await seedSubdomain(db.pool)

  for (const slug of ['health', 'robots.txt', 'favicon.ico', '_status']) {
    await assert.rejects(
      () =>
        db.pool.query(
          `INSERT INTO links (subdomain_id, slug, target_url) VALUES ($1, $2, 'https://x.example')`,
          [sub, slug]
        ),
      /links_slug_not_reserved/,
      `slug "${slug}" must be rejected`
    )
  }
})

test('links: redirect_type defaults to 302', async (t) => {
  const db = await migratedDatabase('schema_302')
  t.after(() => db.end())
  const sub = await seedSubdomain(db.pool)

  const { rows } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     VALUES ($1, 'promo', 'https://x.example') RETURNING redirect_type`,
    [sub]
  )
  assert.equal(rows[0].redirect_type, 302)
})

test('link_versions: survive the deletion of their link', async (t) => {
  const db = await migratedDatabase('schema_versions')
  t.after(() => db.end())
  const sub = await seedSubdomain(db.pool)

  const { rows } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     VALUES ($1, 'promo', 'https://x.example') RETURNING id`,
    [sub]
  )
  const linkId = rows[0].id
  await db.pool.query(
    `INSERT INTO link_versions (link_id, source, before, after)
     VALUES ($1, 'panel', '{"target_url":"https://old.example"}'::jsonb,
                          '{"target_url":"https://x.example"}'::jsonb)`,
    [linkId]
  )

  await db.pool.query('DELETE FROM links WHERE id = $1', [linkId])
  const { rows: kept } = await db.pool.query('SELECT link_id FROM link_versions')
  assert.equal(kept.length, 1, 'history must outlive the row it describes')
  assert.equal(kept[0].link_id, null, 'the reference is nulled, the record stays')
})

test('schedules: an empty patch and an empty target list are rejected', async (t) => {
  const db = await migratedDatabase('schema_schedules')
  t.after(() => db.end())
  const sub = await seedSubdomain(db.pool)
  const { rows } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     VALUES ($1, 'promo', 'https://x.example') RETURNING id`,
    [sub]
  )

  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO schedules (link_ids, fire_at, author_timezone, patch)
         VALUES (ARRAY[$1::uuid], now() + interval '1 hour', 'America/Sao_Paulo', '{}'::jsonb)`,
        [rows[0].id]
      ),
    /schedules_patch_not_empty/
  )

  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO schedules (link_ids, fire_at, author_timezone, patch)
         VALUES (ARRAY[]::uuid[], now() + interval '1 hour', 'America/Sao_Paulo',
                 '{"target_url":"https://y.example"}'::jsonb)`
      ),
    /schedules_has_targets/
  )
})

// ── analytics ───────────────────────────────────────────────────────────────

test('click_events: is partitioned by range on occurred_at', async (t) => {
  const db = await migratedDatabase('schema_events')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `SELECT c.relkind, p.partstrat
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_partitioned_table p ON p.partrelid = c.oid
      WHERE n.nspname = 'schema_events' AND c.relname = 'click_events'`
  )
  assert.equal(rows[0].relkind, 'p', 'click_events must be a partitioned table')
  assert.equal(rows[0].partstrat, 'r', 'partitioning must be by RANGE')
})

test('click_events: a row with no matching month lands in the default partition', async (t) => {
  const db = await migratedDatabase('schema_events_default')
  t.after(() => db.end())
  const sub = await seedSubdomain(db.pool)
  const { rows: l } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     VALUES ($1, 'promo', 'https://x.example') RETURNING id`,
    [sub]
  )

  // Far future: no partition exists for it. Without a default partition this
  // insert would fail and the click would be lost.
  await db.pool.query(
    `INSERT INTO click_events (link_id, occurred_at, is_bot)
     VALUES ($1, '2999-01-01T00:00:00Z', false)`,
    [l[0].id]
  )
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM click_events')
  assert.equal(rows[0].n, 1)
})

test('ensure_click_partition: creates a month partition and is idempotent', async (t) => {
  const db = await migratedDatabase('schema_partitions')
  t.after(() => db.end())

  const { rows: a } = await db.pool.query(
    `SELECT ensure_click_partition('2026-03-01'::date) AS name`
  )
  assert.equal(a[0].name, 'click_events_2026_03')
  const { rows: b } = await db.pool.query(
    `SELECT ensure_click_partition('2026-03-15'::date) AS name`
  )
  assert.equal(b[0].name, 'click_events_2026_03', 'any day of the month maps to the same partition')

  const { rows: parts } = await db.pool.query(
    `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'schema_partitions' AND c.relname = 'click_events_2026_03'`
  )
  assert.equal(parts[0].n, 1, 'calling twice must not create two partitions')
})

test('click_events: no raw IP column exists', async (t) => {
  const db = await migratedDatabase('schema_events_pii')
  t.after(() => db.end())

  const { rows } = await db.pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'schema_events_pii' AND table_name = 'click_events'`
  )
  const cols = rows.map((r) => r.column_name)
  assert.ok(cols.includes('ip_hash'), 'ip_hash must exist')
  assert.ok(!cols.includes('ip'), 'a raw ip column must not exist')
  assert.ok(!cols.includes('ip_address'), 'a raw ip_address column must not exist')
})

test('click_daily: one row per link per day', async (t) => {
  const db = await migratedDatabase('schema_daily')
  t.after(() => db.end())
  const sub = await seedSubdomain(db.pool)
  const { rows: l } = await db.pool.query(
    `INSERT INTO links (subdomain_id, slug, target_url)
     VALUES ($1, 'promo', 'https://x.example') RETURNING id`,
    [sub]
  )

  await db.pool.query(
    `INSERT INTO click_daily (link_id, day, clicks, uniques) VALUES ($1, '2026-03-01', 10, 8)`,
    [l[0].id]
  )
  await assert.rejects(
    () =>
      db.pool.query(
        `INSERT INTO click_daily (link_id, day, clicks, uniques) VALUES ($1, '2026-03-01', 3, 3)`,
        [l[0].id]
      ),
    /duplicate key/
  )
})
