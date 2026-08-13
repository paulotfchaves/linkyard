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
      // SSL is opt-in through the connection string, never guessed. Guessing
      // "not localhost, therefore TLS" breaks Railway's private network, which
      // speaks plain TCP inside the project and rejects the handshake outright.
      // A provider that wants TLS says so with ?sslmode=require.
      ssl: /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
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
