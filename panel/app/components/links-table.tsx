import { Link } from 'react-router'
import { useState } from 'react'
import { StatusBadge, Tag, type LinkStatus } from './ui.tsx'

// The working surface. Obeys the Quiet Table Rule from DESIGN.md: nothing here
// animates on its own, because a person is reading it.

export type LinkRowView = {
  id: string
  host: string
  slug: string
  targetUrl: string
  status: LinkStatus
  tagName: string | null
  clicks: number
  isPinned: boolean
}

export type TableLabels = {
  slug: string
  destination: string
  status: string
  tag: string
  clicks: string
  selectAll: string
  selectRow: string
  copy: string
  copied: string
  pinned: string
  edit: string
  selectedCount: (n: number) => string
  clear: string
  // Status labels are indexed by LinkStatus, so adding a status to the union
  // without translating it becomes a build error rather than a raw enum leaking
  // into the interface.
} & Record<LinkStatus, string>

function shortUrl(row: LinkRowView) {
  return `${row.host}/${row.slug}`
}

// The destination is the widest column and the least scannable. Showing host
// and path separately lets the eye find the domain without reading the query
// string, which is where the noise lives.
function DestinationCell({ url }: { url: string }) {
  let host = url
  let rest = ''
  try {
    const parsed = new URL(url)
    host = parsed.host
    rest = parsed.pathname === '/' ? '' : parsed.pathname
  } catch {
    /* a malformed destination still renders as its raw string */
  }
  return (
    <span className="destination" title={url}>
      <span className="destination__host">{host}</span>
      {rest && <span className="destination__path">{rest}</span>}
    </span>
  )
}

function CopyButton({ value, labels }: { value: string; labels: TableLabels }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="icon-btn"
      title={copied ? labels.copied : labels.copy}
      aria-label={copied ? labels.copied : labels.copy}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch {
          /* clipboard denied: the URL is visible and selectable anyway */
        }
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

export function LinksTable({
  rows,
  labels,
  selected,
  onSelectedChange,
}: {
  rows: LinkRowView[]
  labels: TableLabels
  selected: string[]
  onSelectedChange: (ids: string[]) => void
}) {
  const pageIds = rows.map((r) => r.id)
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id))

  function toggleAll() {
    onSelectedChange(
      allSelected
        ? selected.filter((id) => !pageIds.includes(id))
        : [...new Set([...selected, ...pageIds])]
    )
  }

  function toggle(id: string) {
    onSelectedChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    )
  }

  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="table__check">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label={labels.selectAll}
              />
            </th>
            <th>{labels.slug}</th>
            <th>{labels.destination}</th>
            <th>{labels.tag}</th>
            <th>{labels.status}</th>
            <th className="table__num">{labels.clicks}</th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelected = selected.includes(row.id)
            return (
              <tr key={row.id} data-selected={isSelected || undefined}>
                <td className="table__check">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(row.id)}
                    aria-label={`${labels.selectRow}: ${shortUrl(row)}`}
                  />
                </td>
                <td>
                  <span className="slug-cell">
                    {row.isPinned && (
                      <span className="slug-cell__pin" title={labels.pinned} aria-label={labels.pinned}>
                        ◆
                      </span>
                    )}
                    <Link to={`/links/${row.id}`} className="mono slug-cell__link">
                      {shortUrl(row)}
                    </Link>
                    <CopyButton value={`https://${shortUrl(row)}`} labels={labels} />
                  </span>
                </td>
                <td className="t-muted">
                  <DestinationCell url={row.targetUrl} />
                </td>
                <td>{row.tagName ? <Tag>{row.tagName}</Tag> : <span className="t-faint">—</span>}</td>
                <td>
                  <StatusBadge status={row.status} label={labels[row.status] ?? row.status} />
                </td>
                <td className="table__num tabular">{row.clicks.toLocaleString()}</td>
                <td className="table__num">
                  <Link to={`/links/${row.id}`} className="row-edit">
                    {labels.edit}
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function SelectionBar({
  count,
  labels,
  onClear,
  children,
}: {
  count: number
  labels: TableLabels
  onClear: () => void
  children?: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div className="selection-bar" role="region" aria-live="polite">
      <span className="t-label">{labels.selectedCount(count)}</span>
      <div className="selection-bar__actions">
        {children}
        <button type="button" className="btn btn--quiet btn--small" onClick={onClear}>
          {labels.clear}
        </button>
      </div>
    </div>
  )
}
