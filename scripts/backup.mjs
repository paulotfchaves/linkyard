#!/usr/bin/env node

// Backup and restore: the configuration an operator built, not the traffic it
// received.
//
// What goes in the file is the decision that matters here.
//
// Credentials are NOT exported. The Cloudflare tokens in `credentials` are
// sealed with this installation's ENCRYPTION_KEY, so a copy of them is useless
// to any other installation and dangerous in a file: exporting them sealed
// produces a restore that silently cannot decrypt anything, and exporting them
// open turns a backup into a credential leak that lives in whatever bucket the
// operator drops it in. The restore says which ones to re-enter instead.
//
// Click history is not exported either. It is measured in millions of rows and
// is not what somebody rebuilding a service needs at 3am — they need their
// links to resolve. Aggregates are offered behind a flag for the operator who
// wants their charts back.
//
// Everything is keyed by natural identity — a domain by its apex, a link by
// host and slug — never by the UUID it happened to be assigned, so a restore
// into a fresh database is a merge rather than a collision.

import { readFile, writeFile } from 'node:fs/promises'
import { argv, stdout, exit } from 'node:process'
import pg from 'pg'

export const FORMAT = 'linkyard.backup/1'

const TABLES = ['domains', 'subdomains', 'tags', 'links', 'schedules', 'users', 'grants', 'settings']

function sslFor(connectionString) {
  // Opt-in only. Guessing "not localhost, therefore TLS" breaks a private
  // network that speaks plain TCP, and the failure reads like an outage.
  return /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined
}

export async function exportAll(pool, { includeStats = false } = {}) {
  const out = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    // Stated in the file rather than inferred on the way back in: a restore
    // that guesses which schema wrote it is a restore that corrupts one.
    schemaVersion: (await pool.query('SELECT max(version) AS v FROM schema_migrations')).rows[0]?.v ?? null,
    notes: [
      'Cloudflare credentials are deliberately absent: they are sealed with the ENCRYPTION_KEY of the installation that wrote this file, so they cannot be read anywhere else. Re-enter them in the panel after restoring.',
      'Click history is not included. Links, domains, schedules, members and permissions are.',
    ],
    data: {},
  }

  out.data.domains = (
    await pool.query('SELECT apex, root_policy, root_target, active, created_at FROM domains ORDER BY apex')
  ).rows
  out.data.subdomains = (
    await pool.query(
      `SELECT s.host, d.apex, s.record_type, s.record_value, s.root_policy, s.root_target,
              s.fallback_url, s.active, s.created_at
         FROM subdomains s JOIN domains d ON d.id = s.domain_id ORDER BY s.host`
    )
  ).rows
  out.data.tags = (
    await pool.query('SELECT name, kind, description, color, active FROM tags ORDER BY name')
  ).rows
  out.data.links = (
    await pool.query(
      `SELECT s.host, l.slug, l.target_url, l.redirect_type, l.fallback_url, l.note,
              l.is_pinned, l.pass_through, l.expires_at, l.deleted_at, l.active,
              l.utm_id, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
              l.params, t.name AS tag_name, l.created_at
         FROM links l
         JOIN subdomains s ON s.id = l.subdomain_id
         LEFT JOIN tags t ON t.id = l.tag_id
        ORDER BY s.host, l.slug`
    )
  ).rows

  // A schedule targets a set of links and carries a patch, so its natural
  // identity is the set — resolved to host/slug pairs here, and back to
  // whatever ids the restoring database assigns on the way in.
  out.data.schedules = (
    await pool.query(
      `SELECT sc.fire_at, sc.author_timezone, sc.patch, sc.status, sc.note, sc.created_at,
              (SELECT coalesce(json_agg(json_build_object('host', s.host, 'slug', l.slug)
                                        ORDER BY s.host, l.slug), '[]'::json)
                 FROM links l JOIN subdomains s ON s.id = l.subdomain_id
                WHERE l.id = ANY(sc.link_ids)) AS targets
         FROM schedules sc
        WHERE sc.status = 'pending'
        ORDER BY sc.fire_at`
    )
  ).rows

  // Password hashes travel with the user. They are already one-way, and a
  // restore that drops them locks every member out of the account they are
  // being restored into.
  out.data.users = (
    await pool.query(
      'SELECT email, username, role, timezone, locale, status, password_hash, created_at FROM users ORDER BY email'
    )
  ).rows
  out.data.grants = (
    await pool.query(
      `SELECT u.email, g.resource, g.action, d.apex AS scope_apex
         FROM grants g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN domains d ON d.id = g.scope_domain_id
        ORDER BY u.email, g.resource, g.action`
    )
  ).rows
  out.data.settings = (await pool.query('SELECT key, value FROM settings ORDER BY key')).rows

  if (includeStats) {
    out.data.click_daily = (
      await pool.query(
        `SELECT s.host, l.slug, cd.day, cd.clicks, cd.uniques, cd.bot_clicks,
                cd.by_country, cd.by_device, cd.by_referrer
           FROM click_daily cd
           JOIN links l ON l.id = cd.link_id
           JOIN subdomains s ON s.id = l.subdomain_id
          ORDER BY cd.day`
      )
    ).rows
  }

  return out
}

export function assertRestorable(backup) {
  if (!backup || typeof backup !== 'object') throw new Error('not a backup file')
  if (backup.format !== FORMAT) {
    throw new Error(`unrecognised backup format: ${backup.format ?? '(none)'} — expected ${FORMAT}`)
  }
  if (!backup.data || typeof backup.data !== 'object') throw new Error('backup has no data')
  for (const table of TABLES) {
    if (backup.data[table] !== undefined && !Array.isArray(backup.data[table])) {
      throw new Error(`${table} must be a list`)
    }
  }
  return backup
}

/**
 * Restore, as a merge.
 *
 * Every insert is ON CONFLICT DO NOTHING against the natural key, so running
 * the same file twice changes nothing the second time. A restore that fails
 * halfway is worse than one that refuses to start, so the whole thing is one
 * transaction.
 */
export async function importAll(pool, backup, { dryRun = false } = {}) {
  assertRestorable(backup)
  const data = backup.data
  const counts = {}
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const row of data.domains ?? []) {
      const r = await client.query(
        `INSERT INTO domains (apex, root_policy, root_target, active)
         VALUES ($1, $2, $3, coalesce($4, true))
         ON CONFLICT (lower(apex)) DO NOTHING`,
        [row.apex, row.root_policy, row.root_target, row.active]
      )
      counts.domains = (counts.domains ?? 0) + r.rowCount
    }

    for (const row of data.subdomains ?? []) {
      const r = await client.query(
        `INSERT INTO subdomains (domain_id, host, record_type, record_value, root_policy, root_target, fallback_url, active)
         SELECT d.id, $2, $3, $4, $5, $6, $7, coalesce($8, true) FROM domains d WHERE d.apex = $1
         ON CONFLICT (lower(host)) DO NOTHING`,
        [row.apex, row.host, row.record_type, row.record_value, row.root_policy, row.root_target, row.fallback_url, row.active]
      )
      counts.subdomains = (counts.subdomains ?? 0) + r.rowCount
    }

    for (const row of data.tags ?? []) {
      const r = await client.query(
        `INSERT INTO tags (name, kind, description, color, active)
         VALUES ($1, $2, $3, $4, coalesce($5, true))
         ON CONFLICT (lower(name)) DO NOTHING`,
        [row.name, row.kind, row.description, row.color, row.active]
      )
      counts.tags = (counts.tags ?? 0) + r.rowCount
    }

    for (const row of data.users ?? []) {
      const r = await client.query(
        `INSERT INTO users (email, username, role, timezone, locale, status, password_hash)
         VALUES ($1, $2, $3, coalesce($4, 'UTC'), coalesce($5, 'en'), coalesce($6, 'active'), $7)
         ON CONFLICT (lower(email)) DO NOTHING`,
        [row.email, row.username, row.role, row.timezone, row.locale, row.status, row.password_hash]
      )
      counts.users = (counts.users ?? 0) + r.rowCount
    }

    for (const row of data.links ?? []) {
      const r = await client.query(
        `INSERT INTO links (subdomain_id, slug, target_url, redirect_type, fallback_url, note,
                            is_pinned, pass_through, expires_at, deleted_at, active,
                            utm_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                            params, tag_id)
         SELECT s.id, $2, $3, coalesce($4, 302), $5, $6,
                coalesce($7, false), coalesce($8, false), $9, $10, coalesce($11, true),
                $12, $13, $14, $15, $16, $17, coalesce($18::jsonb, '{}'::jsonb), t.id
           FROM subdomains s LEFT JOIN tags t ON lower(t.name) = lower($19)
          WHERE lower(s.host) = lower($1)
         ON CONFLICT DO NOTHING`,
        [
          row.host, row.slug, row.target_url, row.redirect_type, row.fallback_url, row.note,
          row.is_pinned, row.pass_through, row.expires_at, row.deleted_at, row.active,
          row.utm_id, row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content, row.utm_term,
          row.params === null || row.params === undefined ? null : JSON.stringify(row.params),
          row.tag_name,
        ]
      )
      counts.links = (counts.links ?? 0) + r.rowCount
    }

    for (const row of data.grants ?? []) {
      const r = await client.query(
        `INSERT INTO grants (user_id, resource, action, scope_domain_id)
         SELECT u.id, $2, $3, d.id
           FROM users u LEFT JOIN domains d ON d.apex = $4
          WHERE lower(u.email) = lower($1)
         ON CONFLICT DO NOTHING`,
        [row.email, row.resource, row.action, row.scope_apex]
      )
      counts.grants = (counts.grants ?? 0) + r.rowCount
    }

    // Schedules carry no natural key of their own, so a repeated restore would
    // duplicate them. The guard is the tuple that makes two schedules the same
    // schedule: same moment, same patch, same set of links.
    for (const row of data.schedules ?? []) {
      const targets = Array.isArray(row.targets) ? row.targets : []
      if (targets.length === 0) continue

      const { rows: resolved } = await client.query(
        `SELECT l.id FROM links l JOIN subdomains s ON s.id = l.subdomain_id
          WHERE (lower(s.host), lower(l.slug)) IN (
                  SELECT lower(t->>'host'), lower(t->>'slug') FROM jsonb_array_elements($1::jsonb) AS t)
            AND l.deleted_at IS NULL`,
        [JSON.stringify(targets)]
      )
      // A schedule whose links did not survive is not restored: firing a patch
      // at a different set than the one it was written for is worse than not
      // firing it at all.
      if (resolved.length !== targets.length) continue

      const ids = resolved.map((r) => r.id)
      const { rows: already } = await client.query(
        `SELECT 1 FROM schedules
          WHERE fire_at = $1 AND patch = $2::jsonb AND status = 'pending'
            AND link_ids @> $3::uuid[] AND link_ids <@ $3::uuid[] LIMIT 1`,
        [row.fire_at, JSON.stringify(row.patch), ids]
      )
      if (already.length > 0) continue

      const r = await client.query(
        `INSERT INTO schedules (link_ids, fire_at, author_timezone, patch, status, note)
         VALUES ($1::uuid[], $2, coalesce($3, 'UTC'), $4::jsonb, 'pending', $5)`,
        [ids, row.fire_at, row.author_timezone, JSON.stringify(row.patch), row.note]
      )
      counts.schedules = (counts.schedules ?? 0) + r.rowCount
    }

    for (const row of data.settings ?? []) {
      const r = await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
        [row.key, JSON.stringify(row.value)]
      )
      counts.settings = (counts.settings ?? 0) + r.rowCount
    }

    // A dry run does all the work and keeps none of it: the only honest way to
    // report what a restore would do is to have done it.
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT')
    return counts
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const USAGE = `linkyard backup — export and restore configuration

  node scripts/backup.mjs export <file.json> [--with-stats]
  node scripts/backup.mjs import <file.json> [--dry-run]

Reads DATABASE_URL. Credentials are never exported: they are sealed with this
installation's key and cannot be read anywhere else. Re-enter them after a
restore. Click history is not exported; --with-stats adds the daily aggregates.
`

if (import.meta.url === `file://${argv[1]}`) {
  const [command, file] = argv.slice(2)
  const flags = new Set(argv.slice(2).filter((a) => a.startsWith('--')))
  const connectionString = process.env.DATABASE_URL

  try {
    if (!command || !['export', 'import'].includes(command) || !file || file.startsWith('--')) {
      stdout.write(USAGE)
      exit(command ? 2 : 0)
    }
    if (!connectionString) throw new Error('DATABASE_URL is required')

    const pool = new pg.Pool({ connectionString, ssl: sslFor(connectionString), max: 2 })
    try {
      if (command === 'export') {
        const backup = await exportAll(pool, { includeStats: flags.has('--with-stats') })
        await writeFile(file, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 })
        const total = Object.values(backup.data).reduce((sum, rows) => sum + rows.length, 0)
        stdout.write(`Wrote ${file} — ${total} rows across ${Object.keys(backup.data).length} tables.\n`)
        stdout.write('Credentials are not in it. Re-enter them in the panel after a restore.\n')
      } else {
        const backup = JSON.parse(await readFile(file, 'utf8'))
        const dryRun = flags.has('--dry-run')
        const counts = await importAll(pool, backup, { dryRun })
        const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new'
        stdout.write(`${dryRun ? 'Would insert' : 'Inserted'}: ${summary}.\n`)
        if (dryRun) stdout.write('Nothing was written — this was a dry run.\n')
      }
    } finally {
      await pool.end()
    }
  } catch (err) {
    stdout.write(`\nlinkyard backup: ${err?.message ?? err}\n`)
    exit(1)
  }
}
