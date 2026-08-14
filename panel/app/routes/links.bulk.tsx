import { requireSession } from '~/lib/auth.server.ts'
import { loadGrants, can, type Actor } from '~/lib/permission.server.ts'
import {
  bulkSetActive,
  bulkSetTag,
  bulkSetUtms,
  bulkSwapTarget,
  bulkSoftDelete,
  bulkRestore,
  type BulkResult,
} from '~/lib/bulk.server.ts'
import { createSchedule } from '~/lib/schedules.server.ts'
import { UTM_KEYS, type UtmKey } from '~/lib/links.ts'

// One action endpoint for every bulk intent.
//
// The authorisation shape here is the important part. A single route-level
// check would authorise a batch spanning every domain in the installation, so
// the actor's grants are resolved once and handed to the bulk layer as a
// per-link predicate: a link in a domain they cannot touch fails as `forbidden`
// while the rest go through.

export async function action({ request }: { request: Request }) {
  const session = await requireSession(request)
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')
  const ids = String(form.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

  if (!ids.length) return Response.json({ ok: 0, failed: 0, errors: [] })

  const actor: Actor = { id: session.user.id, role: session.user.role }
  const grants = await loadGrants(actor.id)
  const action = intent === 'delete' ? 'delete' : 'update'
  const authorize = (domainId: string) =>
    can(actor, grants, { resource: 'link', action, domainId })

  // A batch the actor cannot touch anywhere is a 403, not a report of N
  // individual denials — the difference between "you may not do this" and "none
  // of these happened to be yours" matters to whoever reads the message.
  if (!can(actor, grants, { resource: 'link', action })) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  const opts = { authorize }
  let result: BulkResult

  switch (intent) {
    case 'pause':
      result = await bulkSetActive(ids, false, actor.id, opts)
      break
    case 'resume':
      result = await bulkSetActive(ids, true, actor.id, opts)
      break
    case 'tag':
      result = await bulkSetTag(ids, String(form.get('tagId') ?? '') || null, actor.id, opts)
      break
    case 'utms': {
      const raw = JSON.parse(String(form.get('utms') ?? '{}')) as Record<string, string>
      const utms: Partial<Record<UtmKey, string | null>> = {}
      for (const key of UTM_KEYS) {
        const value = (raw[key] ?? '').trim()
        // In replace mode a blank field means "clear this", which is null. In
        // merge mode it means "leave it alone", which is absent.
        if (value) utms[key] = value
        else if (form.get('mode') === 'replace') utms[key] = null
      }
      result = await bulkSetUtms(
        ids,
        utms,
        form.get('mode') === 'replace' ? 'replace' : 'merge',
        actor.id,
        opts
      )
      break
    }
    case 'swap':
      result = await bulkSwapTarget(
        ids,
        {
          mode: form.get('mode') === 'replace' ? 'replace' : 'path',
          value: String(form.get('value') ?? ''),
          find: String(form.get('find') ?? '') || undefined,
          swapHost: String(form.get('swapHost') ?? '') || null,
        },
        actor.id,
        opts
      )
      break
    case 'delete':
      result = await bulkSoftDelete(ids, actor.id, opts)
      break
    case 'restore':
      result = await bulkRestore(ids, actor.id, opts)
      break
    case 'schedule': {
      const when = String(form.get('when') ?? '')
      const fireAt = new Date(when)
      const created = await createSchedule(
        {
          linkIds: ids,
          fireAt,
          authorTimezone: String(form.get('timezone') ?? 'UTC'),
          patch: {
            targetUrl: String(form.get('targetUrl') ?? '') || undefined,
            tagId: String(form.get('tagId') ?? '') || undefined,
          },
          note: String(form.get('note') ?? '') || undefined,
        },
        actor.id
      )
      return Response.json({ ok: ids.length, failed: 0, errors: [], scheduleId: created.id })
    }
    default:
      return Response.json({ ok: 0, failed: 0, errors: [{ reason: 'unknown_intent' }] })
  }

  return Response.json(result)
}
