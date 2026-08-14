import { useFetcher } from 'react-router'
import { useState } from 'react'
import { Button, Field, TextInput } from './ui.tsx'
import { UTM_KEYS, type UtmKey } from '~/lib/links.ts'

// The selection bar and the sheets it opens.
//
// Bulk actions are the fastest way to break a lot of links at once, so every
// destructive or wide-reaching one goes through a sheet that states what will
// happen and to how many, rather than firing from the bar itself.

export type BulkLabels = Record<string, string>

type Sheet = null | 'tag' | 'utms' | 'swap' | 'schedule' | 'delete'

export function BulkBar({
  selected,
  tags,
  labels,
  locale,
  timezone,
  onDone,
  trash = false,
}: {
  selected: string[]
  tags: Array<{ id: string; name: string }>
  labels: BulkLabels
  locale: string
  timezone: string
  onDone: () => void
  trash?: boolean
}) {
  const fetcher = useFetcher<{ ok?: number; failed?: number; errors?: Array<{ reason: string }> }>()
  const [sheet, setSheet] = useState<Sheet>(null)
  const count = selected.length
  const busy = fetcher.state !== 'idle'

  if (count === 0) return null

  function submit(intent: string, extra: Record<string, string> = {}) {
    const data = new FormData()
    data.set('intent', intent)
    data.set('ids', selected.join(','))
    for (const [k, v] of Object.entries(extra)) data.set(k, v)
    fetcher.submit(data, { method: 'post', action: '/links/bulk' })
    setSheet(null)
    onDone()
  }

  return (
    <>
      <div className="selection-bar" role="region" aria-live="polite">
        <span className="t-label">{fmt(labels['bulk.selected'], { count })}</span>

        <div className="selection-bar__actions">
          {trash ? (
            <Button small onClick={() => submit('restore')} disabled={busy}>
              {labels['bulk.restore']}
            </Button>
          ) : (
            <>
              <Button small onClick={() => submit('pause')} disabled={busy}>
                {labels['bulk.pause']}
              </Button>
              <Button small onClick={() => submit('resume')} disabled={busy}>
                {labels['bulk.resume']}
              </Button>
              <Button small onClick={() => setSheet('tag')} disabled={busy}>
                {labels['bulk.tag']}
              </Button>
              <Button small onClick={() => setSheet('utms')} disabled={busy}>
                {labels['bulk.utms']}
              </Button>
              <Button small onClick={() => setSheet('swap')} disabled={busy}>
                {labels['bulk.swap']}
              </Button>
              <Button small onClick={() => setSheet('schedule')} disabled={busy}>
                {labels['bulk.schedule']}
              </Button>
              <Button small tone="danger" onClick={() => setSheet('delete')} disabled={busy}>
                {labels['bulk.delete']}
              </Button>
            </>
          )}
          <button type="button" className="btn btn--quiet btn--small" onClick={onDone}>
            {labels['table.clear'] ?? '×'}
          </button>
        </div>
      </div>

      {fetcher.data && (
        <div className="bulk-result" role="status">
          <span>{fmt(labels['bulk.result.ok'], { ok: fetcher.data.ok ?? 0 })}</span>
          {(fetcher.data.failed ?? 0) > 0 && (
            <span className="bulk-result__failed">
              {fmt(labels['bulk.result.failed'], { failed: fetcher.data.failed ?? 0 })}
              {/* The reason matters more than the count: "not allowed on this
                  domain" and "that path is taken" call for different fixes. */}
              {fetcher.data.errors?.[0] &&
                ` — ${labels[`bulk.error.${fetcher.data.errors[0].reason}`] ?? fetcher.data.errors[0].reason}`}
            </span>
          )}
        </div>
      )}

      {sheet && (
        <Sheet title={labels[`bulk.${sheet}`] ?? ''} onClose={() => setSheet(null)}>
          {sheet === 'tag' && <TagSheet tags={tags} labels={labels} count={count} onSubmit={submit} />}
          {sheet === 'utms' && <UtmSheet labels={labels} count={count} onSubmit={submit} />}
          {sheet === 'swap' && <SwapSheet labels={labels} count={count} onSubmit={submit} />}
          {sheet === 'schedule' && (
            <ScheduleSheet
              labels={labels}
              count={count}
              tags={tags}
              locale={locale}
              timezone={timezone}
              onSubmit={submit}
            />
          )}
          {sheet === 'delete' && (
            <div className="sheet__body">
              <p className="t-prose">{fmt(labels['bulk.confirm.delete'], { count })}</p>
              <div className="editor__actions">
                <Button tone="danger" onClick={() => submit('delete')}>
                  {labels['bulk.delete']}
                </Button>
                <Button onClick={() => setSheet(null)}>{labels['schedule.cancel']}</Button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </>
  )
}

function fmt(template: string | undefined, params: Record<string, string | number>): string {
  if (!template) return ''
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    key in params ? String(params[key]) : whole
  )
}

function Sheet({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__head">
          <h2 className="t-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function TagSheet({
  tags,
  labels,
  count,
  onSubmit,
}: {
  tags: Array<{ id: string; name: string }>
  labels: BulkLabels
  count: number
  onSubmit: (intent: string, extra: Record<string, string>) => void
}) {
  const [tagId, setTagId] = useState('')
  return (
    <div className="sheet__body">
      <Field label={labels['bulk.tag']} id="bulk-tag">
        <select
          id="bulk-tag"
          className="field__input"
          value={tagId}
          onChange={(e) => setTagId(e.currentTarget.value)}
        >
          <option value="">{labels['editor.tag.none']}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="editor__actions">
        <Button tone="primary" arrow onClick={() => onSubmit('tag', { tagId })}>
          {fmt(labels['bulk.apply'], { count })}
        </Button>
      </div>
    </div>
  )
}

function UtmSheet({
  labels,
  count,
  onSubmit,
}: {
  labels: BulkLabels
  count: number
  onSubmit: (intent: string, extra: Record<string, string>) => void
}) {
  const [values, setValues] = useState<Partial<Record<UtmKey, string>>>({})
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')

  return (
    <div className="sheet__body">
      <div className="editor__grid">
        {UTM_KEYS.map((key) => (
          <Field key={key} label={labels[`editor.utm.${key.replace('utm_', '')}`] ?? key} id={`b-${key}`}>
            <TextInput
              id={`b-${key}`}
              value={values[key] ?? ''}
              onChange={(e) => setValues({ ...values, [key]: e.currentTarget.value })}
            />
          </Field>
        ))}
      </div>

      {/* What happens to a field left blank is the whole question here, and
          guessing it wrong wipes tracking on hundreds of links. */}
      <Field label={labels['bulk.utm.mode']} id="utm-mode">
        <select
          id="utm-mode"
          className="field__input"
          value={mode}
          onChange={(e) => setMode(e.currentTarget.value as 'merge' | 'replace')}
        >
          <option value="merge">{labels['bulk.utm.mode.merge']}</option>
          <option value="replace">{labels['bulk.utm.mode.replace']}</option>
        </select>
      </Field>

      <div className="editor__actions">
        <Button
          tone="primary"
          arrow
          onClick={() => onSubmit('utms', { mode, utms: JSON.stringify(values) })}
        >
          {fmt(labels['bulk.apply'], { count })}
        </Button>
      </div>
    </div>
  )
}

function SwapSheet({
  labels,
  count,
  onSubmit,
}: {
  labels: BulkLabels
  count: number
  onSubmit: (intent: string, extra: Record<string, string>) => void
}) {
  const [mode, setMode] = useState<'path' | 'replace'>('path')
  const [value, setValue] = useState('')
  const [find, setFind] = useState('')
  const [swapHost, setSwapHost] = useState('')

  return (
    <div className="sheet__body">
      <Field label={labels['bulk.swap.mode']} id="swap-mode">
        <select
          id="swap-mode"
          className="field__input"
          value={mode}
          onChange={(e) => setMode(e.currentTarget.value as 'path' | 'replace')}
        >
          <option value="path">{labels['bulk.swap.mode.path']}</option>
          <option value="replace">{labels['bulk.swap.mode.replace']}</option>
        </select>
      </Field>

      {mode === 'replace' && (
        <Field label={labels['bulk.swap.find']} id="swap-find">
          <TextInput id="swap-find" value={find} onChange={(e) => setFind(e.currentTarget.value)} />
        </Field>
      )}

      <Field label={labels['bulk.swap.value']} id="swap-value">
        <TextInput id="swap-value" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
      </Field>

      {mode === 'path' && (
        <Field label={labels['bulk.swap.host']} id="swap-host">
          <TextInput
            id="swap-host"
            value={swapHost}
            onChange={(e) => setSwapHost(e.currentTarget.value)}
            placeholder="example.com"
          />
        </Field>
      )}

      <div className="editor__actions">
        <Button
          tone="primary"
          arrow
          onClick={() => onSubmit('swap', { mode, value, find, swapHost })}
          disabled={!value}
        >
          {fmt(labels['bulk.apply'], { count })}
        </Button>
      </div>
    </div>
  )
}

function ScheduleSheet({
  labels,
  count,
  tags,
  locale,
  timezone,
  onSubmit,
}: {
  labels: BulkLabels
  count: number
  tags: Array<{ id: string; name: string }>
  locale: string
  timezone: string
  onSubmit: (intent: string, extra: Record<string, string>) => void
}) {
  const [when, setWhen] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [tagId, setTagId] = useState('')
  const [note, setNote] = useState('')

  // Both readings of the same instant, side by side. The server runs in UTC and
  // the person does not; showing only one of the two is how a launch swap fires
  // three hours off and nobody can explain why.
  let hint = ''
  if (when) {
    const local = new Date(when)
    if (!Number.isNaN(local.getTime())) {
      hint = fmt(labels['schedule.timezone.note'], {
        local: local.toLocaleString(locale, { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }),
        zone: timezone,
        utc: local.toLocaleString(locale, { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' }),
      })
    }
  }

  return (
    <div className="sheet__body">
      <Field label={labels['schedule.when']} id="sched-when" hint={hint}>
        <TextInput
          id="sched-when"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.currentTarget.value)}
        />
      </Field>

      <Field label={labels['editor.destination.label']} id="sched-target">
        <TextInput
          id="sched-target"
          type="url"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.currentTarget.value)}
          placeholder={labels['editor.destination.placeholder']}
        />
      </Field>

      <Field label={labels['editor.tag.label']} id="sched-tag">
        <select
          id="sched-tag"
          className="field__input"
          value={tagId}
          onChange={(e) => setTagId(e.currentTarget.value)}
        >
          <option value="">{labels['editor.tag.none']}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={labels['schedule.note']} id="sched-note">
        <TextInput id="sched-note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      </Field>

      <div className="editor__actions">
        <Button
          tone="primary"
          arrow
          disabled={!when || (!targetUrl && !tagId)}
          onClick={() => onSubmit('schedule', { when, targetUrl, tagId, note, timezone })}
        >
          {fmt(labels['schedule.create'], { count })}
        </Button>
      </div>
    </div>
  )
}
