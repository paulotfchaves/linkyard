import pg from 'pg'

const { Pool } = pg

export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/linkyard_test'

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,48}$/

// Every test file gets its own schema inside the shared test database, so files
// can never see each other's tables even when run in the same process.
//
// search_path is set through the connection `options` rather than a SET query in
// a 'connect' handler: the handler's query is not awaited before the connection
// is handed out, so a pooled connection could serve a query before its
// search_path was applied. Passing it at handshake time has no such race.
export async function freshDatabase(schemaName) {
  if (!SCHEMA_RE.test(schemaName)) {
    throw new TypeError(`invalid test schema name: ${schemaName}`)
  }

  const admin = new Pool({ connectionString: TEST_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
  await admin.query(`CREATE SCHEMA ${schemaName}`)
  await admin.end()

  const pool = new Pool({
    connectionString: TEST_URL,
    max: 4,
    options: `-c search_path=${schemaName},public`,
  })

  return {
    pool,
    schemaName,
    async end() {
      await pool.end()
      const cleanup = new Pool({ connectionString: TEST_URL, max: 1 })
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
      await cleanup.end()
    },
  }
}
