// Production entrypoint: bring the schema up to date, then serve.
//
// Migrations run here rather than in a release command because both install
// targets (Railway and Docker Compose) start the same container, and a schema
// that is one migration behind the code fails in ways that look like data
// corruption rather than like a missed step.
import { spawn } from 'node:child_process'
import pg from 'pg'
import { migrate } from '../db/migrate.mjs'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
})

try {
  const applied = await migrate(pool)
  console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'schema up to date')
} finally {
  await pool.end()
}

const server = spawn(
  process.execPath,
  ['../node_modules/.bin/react-router-serve', './build/server/index.js'],
  { stdio: 'inherit', env: process.env }
)
server.on('exit', (code) => process.exit(code ?? 0))
