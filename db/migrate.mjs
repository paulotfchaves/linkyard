import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = join(HERE, 'migrations')

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`

export async function appliedVersions(pool) {
  await pool.query(LEDGER)
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
  return rows.map((r) => r.version)
}

// Applies every .sql file not yet recorded, in filename order. Each file runs
// inside its own transaction together with its ledger insert: a file either
// lands whole and is recorded, or leaves nothing behind. A half-applied
// migration that still counts as applied is the worst outcome available here.
export async function migrate(pool, dir = MIGRATIONS_DIR) {
  const done = new Set(await appliedVersions(pool))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  const applied = []
  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (done.has(version)) continue

    const sql = await readFile(join(dir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
      await client.query('COMMIT')
      applied.push(version)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`migration ${version} failed: ${err.message}`, { cause: err })
    } finally {
      client.release()
    }
  }
  return applied
}

// CLI: node db/migrate.mjs
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 })
  try {
    const applied = await migrate(pool)
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date')
  } finally {
    await pool.end()
  }
}
