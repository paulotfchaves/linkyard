import { query, queryOne, transaction } from './db.server.ts'
import type { Utms, LinkInput, LinkStatus } from './links.ts'

// Database access for links. The rules themselves live in links.ts, which this
// file re-exports so a caller needs only one import.
export * from './links.ts'

export type LinkRow = {
  id: string
  subdomain_id: string
  host: string
  slug: string
  target_url: string
  redirect_type: number
  utm_id: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  params: Record<string, string>
  pass_through: boolean
  is_pinned: boolean
  expires_at: Date | null
  fallback_url: string | null
  tag_id: string | null
  tag_name: string | null
  note: string | null
  active: boolean
  created_at: Date
  updated_at: Date
  clicks: number
  scheduled: boolean
}

export type ListFilters = {
  search?: string | null
  domainId?: string | null
  tagId?: string | null
  status?: LinkStatus | 'all' | null
  sort?: 'recent' | 'clicks' | 'slug'
  page?: number
  perPage?: number
}

const SORTS: Record<string, string> = {
  recent: 'l.created_at DESC',
  clicks: 'clicks DESC NULLS LAST',
  slug: 'l.slug ASC',
}

export async function listLinks(filters: ListFilters = {}) {
  const perPage = Math.min(Math.max(filters.perPage ?? 50, 1), 200)
  const page = Math.max(filters.page ?? 1, 1)
  const offset = (page - 1) * perPage

  const where: string[] = []
  const params: unknown[] = []
  const add = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }

  if (filters.search) {
    const like = `%${filters.search.trim()}%`
    where.push(`(l.slug ILIKE ${add(like)} OR l.target_url ILIKE ${add(like)})`)
  }
  if (filters.domainId) where.push(`s.domain_id = ${add(filters.domainId)}`)
  if (filters.tagId) where.push(`l.tag_id = ${add(filters.tagId)}`)

  switch (filters.status) {
    case 'active':
      where.push(`l.active AND (l.expires_at IS NULL OR l.expires_at > now())`)
      break
    case 'paused':
      where.push(`NOT l.active`)
      break
    case 'expired':
      where.push(`l.expires_at IS NOT NULL AND l.expires_at <= now()`)
      break
    case 'scheduled':
      where.push(`EXISTS (
        SELECT 1 FROM schedules sc
         WHERE sc.status = 'pending' AND l.id = ANY(sc.link_ids)
      )`)
      break
    default:
      break
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const orderSql = SORTS[filters.sort ?? 'recent'] ?? SORTS.recent

  const rows = await query<LinkRow>(
    `SELECT l.*, s.host, t.name AS tag_name,
            COALESCE(c.total, 0)::int AS clicks,
            EXISTS (
              SELECT 1 FROM schedules sc
               WHERE sc.status = 'pending' AND l.id = ANY(sc.link_ids)
            ) AS scheduled
       FROM links l
       JOIN subdomains s ON s.id = l.subdomain_id
       LEFT JOIN tags t ON t.id = l.tag_id
       LEFT JOIN (
            SELECT link_id, SUM(clicks) AS total FROM click_daily GROUP BY link_id
       ) c ON c.link_id = l.id
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ${perPage} OFFSET ${offset}`,
    params
  )

  const counted = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM links l
       JOIN subdomains s ON s.id = l.subdomain_id
       ${whereSql}`,
    params
  )

  return { rows, total: counted?.total ?? 0, page, perPage }
}

export async function getLink(id: string): Promise<LinkRow | null> {
  return queryOne<LinkRow>(
    `SELECT l.*, s.host, t.name AS tag_name, 0::int AS clicks, false AS scheduled
       FROM links l
       JOIN subdomains s ON s.id = l.subdomain_id
       LEFT JOIN tags t ON t.id = l.tag_id
      WHERE l.id = $1`,
    [id]
  )
}


const COLUMNS = [
  'subdomain_id',
  'slug',
  'target_url',
  'redirect_type',
  'utm_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'params',
  'pass_through',
  'is_pinned',
  'expires_at',
  'fallback_url',
  'tag_id',
  'note',
  'active',
] as const

function toRow(input: LinkInput) {
  const u = input.utms ?? {}
  return {
    subdomain_id: input.subdomainId,
    slug: input.slug.trim(),
    target_url: input.targetUrl.trim(),
    redirect_type: input.redirectType ?? 302,
    utm_id: u.utm_id ?? null,
    utm_source: u.utm_source ?? null,
    utm_medium: u.utm_medium ?? null,
    utm_campaign: u.utm_campaign ?? null,
    utm_content: u.utm_content ?? null,
    utm_term: u.utm_term ?? null,
    params: JSON.stringify(input.params ?? {}),
    pass_through: input.passThrough ?? false,
    is_pinned: input.isPinned ?? false,
    expires_at: input.expiresAt ?? null,
    fallback_url: input.fallbackUrl ?? null,
    tag_id: input.tagId ?? null,
    note: input.note ?? null,
    active: input.active ?? true,
  } as Record<string, unknown>
}

// Every write records the version and the audit entry in the same transaction
// as the change itself. History that can be lost while the change survives is
// not history.
export async function createLink(input: LinkInput, actorId: string | null): Promise<LinkRow> {
  const row = toRow(input)
  return transaction(async (client) => {
    const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ')
    const values = COLUMNS.map((c) => row[c])
    const created = await client.query(
      `INSERT INTO links (${COLUMNS.join(', ')}, created_by)
       VALUES (${placeholders}, $${COLUMNS.length + 1})
       RETURNING *`,
      [...values, actorId]
    )
    const link = created.rows[0]

    await client.query(
      `INSERT INTO link_versions (link_id, changed_by, source, before, after)
       VALUES ($1, $2, 'panel', '{}'::jsonb, $3::jsonb)`,
      [link.id, actorId, JSON.stringify(link)]
    )
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'link.create', 'link', $2, $3::jsonb)`,
      [actorId, link.id, JSON.stringify({ slug: link.slug, target_url: link.target_url })]
    )
    return link
  })
}

export async function updateLink(
  id: string,
  input: LinkInput,
  actorId: string | null
): Promise<LinkRow> {
  const row = toRow(input)
  return transaction(async (client) => {
    const before = await client.query('SELECT * FROM links WHERE id = $1', [id])
    if (!before.rowCount) throw new Response('Not found', { status: 404 })

    const sets = COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const values = COLUMNS.map((c) => row[c])
    const updated = await client.query(
      `UPDATE links SET ${sets} WHERE id = $${COLUMNS.length + 1} RETURNING *`,
      [...values, id]
    )
    const link = updated.rows[0]

    await client.query(
      `INSERT INTO link_versions (link_id, changed_by, source, before, after)
       VALUES ($1, $2, 'panel', $3::jsonb, $4::jsonb)`,
      [id, actorId, JSON.stringify(before.rows[0]), JSON.stringify(link)]
    )
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'link.update', 'link', $2, $3::jsonb, $4::jsonb)`,
      [
        actorId,
        id,
        JSON.stringify({ target_url: before.rows[0].target_url, active: before.rows[0].active }),
        JSON.stringify({ target_url: link.target_url, active: link.active }),
      ]
    )
    return link
  })
}

export async function setLinkActive(id: string, active: boolean, actorId: string | null) {
  return transaction(async (client) => {
    const updated = await client.query(
      'UPDATE links SET active = $1 WHERE id = $2 RETURNING id, slug, active',
      [active, id]
    )
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, $2, 'link', $3, $4::jsonb)`,
      [actorId, active ? 'link.activate' : 'link.pause', id, JSON.stringify({ active })]
    )
    return updated.rows[0]
  })
}
