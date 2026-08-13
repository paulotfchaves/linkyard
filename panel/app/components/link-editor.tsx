import { Form, Link } from 'react-router'
import { useState } from 'react'
import { Button, Field, TextInput } from './ui.tsx'
import { UTM_KEYS, splitUtmsFromUrl, type UtmKey } from '~/lib/links.ts'

// The destination editor. Four sections, in the order a person thinks about a
// link: where it goes, how it is tracked, how it behaves, how long it lives.

export type EditorLabels = Record<string, string>

export type EditorValues = {
  subdomainId: string
  slug: string
  targetUrl: string
  redirectType: number
  utms: Partial<Record<UtmKey, string>>
  params: Array<{ key: string; value: string }>
  passThrough: boolean
  isPinned: boolean
  expiresAt: string
  fallbackUrl: string
  tagId: string
  note: string
}

export function LinkEditor({
  values,
  subdomains,
  tags,
  labels,
  errors,
  submitLabel,
  busy,
}: {
  values: EditorValues
  subdomains: Array<{ id: string; host: string }>
  tags: Array<{ id: string; name: string }>
  labels: EditorLabels
  errors: Record<string, string | undefined>
  submitLabel: string
  busy: boolean
}) {
  const [target, setTarget] = useState(values.targetUrl)
  const [utms, setUtms] = useState<Partial<Record<UtmKey, string>>>(values.utms)
  const [params, setParams] = useState(values.params)
  const [imported, setImported] = useState<UtmKey[]>([])

  /**
   * Pasting a URL that already carries tracking splits it into the fields.
   *
   * Without this, a person pastes a tagged URL and then types the same six
   * values again by hand — and the two copies drift, which is how a campaign
   * ends up reported under two names.
   */
  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text').trim()
    if (!/^https?:\/\//i.test(text)) return

    const split = splitUtmsFromUrl(text)
    if (!split) return

    event.preventDefault()
    setTarget(split.base)

    const next = { ...utms }
    const filled: UtmKey[] = []
    for (const key of UTM_KEYS) {
      const value = split.utms[key]
      // Only fills what is empty: something already typed was typed on purpose.
      if (value && !next[key]) {
        next[key] = value
        filled.push(key)
      }
    }
    setUtms(next)
    setImported(filled)
    window.setTimeout(() => setImported([]), 2000)
  }

  return (
    <Form method="post" className="editor">
      <section className="editor__section card">
        <h2 className="t-title">{labels.destinationSection}</h2>

        <div className="editor__row">
          <Field label={labels.domain} id="subdomainId">
            <select
              id="subdomainId"
              name="subdomainId"
              className="field__input"
              defaultValue={values.subdomainId}
              required
            >
              {subdomains.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.host}
                </option>
              ))}
            </select>
          </Field>

          <Field label={labels.slug} id="slug" hint={labels.slugHint} error={errors.slug}>
            <TextInput
              id="slug"
              name="slug"
              defaultValue={values.slug}
              required
              invalid={Boolean(errors.slug)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field label={labels.destination} id="targetUrl" error={errors.targetUrl}>
          <TextInput
            id="targetUrl"
            name="targetUrl"
            type="url"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            onPaste={handlePaste}
            placeholder={labels.destinationPlaceholder}
            required
            invalid={Boolean(errors.targetUrl)}
          />
        </Field>
      </section>

      <section className="editor__section card">
        <h2 className="t-title">{labels.trackingSection}</h2>

        <div className="editor__grid">
          {UTM_KEYS.map((key) => (
            <Field key={key} label={labels[key] ?? key} id={key}>
              <TextInput
                id={key}
                name={key}
                value={utms[key] ?? ''}
                onChange={(e) => setUtms({ ...utms, [key]: e.currentTarget.value })}
                className={imported.includes(key) ? 'field__input is-imported' : 'field__input'}
              />
            </Field>
          ))}
        </div>

        <div className="editor__params">
          <span className="t-label t-muted">{labels.paramsTitle}</span>
          {params.map((param, index) => (
            <div className="editor__param" key={index}>
              <input
                className="field__input"
                name="paramKey"
                value={param.key}
                placeholder={labels.paramKey}
                onChange={(e) => {
                  const next = [...params]
                  next[index] = { ...param, key: e.currentTarget.value }
                  setParams(next)
                }}
              />
              <input
                className="field__input"
                name="paramValue"
                value={param.value}
                placeholder={labels.paramValue}
                onChange={(e) => {
                  const next = [...params]
                  next[index] = { ...param, value: e.currentTarget.value }
                  setParams(next)
                }}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={labels.paramRemove}
                onClick={() => setParams(params.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          ))}
          <Button
            small
            type="button"
            onClick={() => setParams([...params, { key: '', value: '' }])}
          >
            {labels.paramsAdd}
          </Button>
        </div>
      </section>

      <section className="editor__section card">
        <h2 className="t-title">{labels.behaviorSection}</h2>

        <div className="editor__row">
          <Field label={labels.tag} id="tagId">
            <select id="tagId" name="tagId" className="field__input" defaultValue={values.tagId}>
              <option value="">{labels.tagNone}</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={labels.expiry} id="expiresAt" hint={labels.expiryHint}>
            <TextInput
              id="expiresAt"
              name="expiresAt"
              type="datetime-local"
              defaultValue={values.expiresAt}
            />
          </Field>
        </div>

        <Field label={labels.fallback} id="fallbackUrl" hint={labels.fallbackHint}>
          <TextInput
            id="fallbackUrl"
            name="fallbackUrl"
            type="url"
            defaultValue={values.fallbackUrl}
          />
        </Field>

        <Field label={labels.note} id="note">
          <TextInput id="note" name="note" defaultValue={values.note} />
        </Field>

        <label className="editor__check">
          <input type="checkbox" name="isPinned" defaultChecked={values.isPinned} />
          <span>{labels.pinned}</span>
        </label>
      </section>

      <input type="hidden" name="params" value={JSON.stringify(params)} />

      <div className="editor__actions">
        <Button tone="primary" type="submit" arrow disabled={busy}>
          {submitLabel}
        </Button>
        <Link to="/links" className="btn btn--quiet">
          {labels.cancel}
        </Link>
      </div>
    </Form>
  )
}
