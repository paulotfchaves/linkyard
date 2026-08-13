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

/**
 * SSL is opt-in through the connection string, never guessed.
 *
 * Guessing "not localhost, therefore TLS" breaks the most common deployment
 * this product has: Railway's private network speaks plain TCP inside the
 * project and rejects an SSL handshake outright. A managed database that does
 * want TLS says so with ?sslmode=require, which is the standard libpq spelling
 * and the one thing every provider documents.
 */
function sslFor(connectionString) {
  if (/[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)) {
    // rejectUnauthorized stays false because managed providers terminate TLS
    // with a certificate chain the container has no root store for. The
    // connection is still encrypted.
    return { rejectUnauthorized: false }
  }
  return undefined
}

const pool = new pg.Pool({ connectionString: url, max: 2, ssl: sslFor(url) })

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
