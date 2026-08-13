import pg from 'pg'

// One pool per process. No ORM and no query builder: the old panel carried a
// hand-written PostgREST emulator purely as historical debt, and every query
// here is plain parameterised SQL instead.

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is required')
    pool = new Pool({
      connectionString,
      max: 6,
      // Railway and most managed Postgres terminate TLS with a certificate the
      // container has no root for. The connection is still encrypted.
      ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
    })
  }
  return pool
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params)
  return result.rows
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
