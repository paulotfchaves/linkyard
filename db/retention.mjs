// Partition lifecycle for click_events.
//
// Two jobs, both idempotent and both safe to run on every boot:
//   - create partitions for the months about to arrive, so inserts land in a
//     real partition instead of the catch-all default;
//   - drop partitions entirely outside the retention window. DROP of a whole
//     partition is instant and reclaims disk immediately, which DELETE does not.
//
// click_daily is never touched: the rollup outlives the raw events, so a chart
// of last year still works after last year's clicks are gone.

const PART_RE = /^click_events_(\d{4})_(\d{2})$/

export async function ensureUpcomingPartitions(pool, monthsAhead = 3) {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 0) {
    throw new TypeError('monthsAhead must be a non-negative integer')
  }
  const created = []
  const now = new Date()
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))
    const iso = d.toISOString().slice(0, 10)
    const { rows } = await pool.query('SELECT ensure_click_partition($1::date) AS name', [iso])
    created.push(rows[0].name)
  }
  return created
}

export async function dropExpiredPartitions(pool, retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('retentionDays must be a positive integer')
  }

  // relkind = 'r' matters: pg_class also holds the indexes each partition
  // inherits from the parent table, and their names share the prefix.
  const { rows } = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname LIKE 'click_events_%'`
  )

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const dropped = []

  for (const { relname } of rows) {
    // click_events_default does not match PART_RE, and that is deliberate: it
    // is the catch-all, and without it an insert for an unpartitioned month
    // fails and the click is lost.
    const m = PART_RE.exec(relname)
    if (!m) continue

    const year = Number(m[1])
    const month = Number(m[2])
    // A partition is expired only once its LAST day is behind the cutoff, so
    // the month currently being written to is never dropped mid-flight.
    const partitionEnd = new Date(Date.UTC(year, month, 1))
    if (partitionEnd > cutoff) continue

    // The identifier is interpolated, which would normally be unacceptable. It
    // is safe here and only here: relname comes from pg_class filtered by
    // PART_RE, so it can only ever be click_events_YYYY_MM. No user input
    // reaches this string.
    await pool.query(`DROP TABLE IF EXISTS "${relname}"`)
    dropped.push(relname)
  }

  return dropped.sort()
}
