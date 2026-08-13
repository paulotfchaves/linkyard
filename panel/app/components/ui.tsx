import type { ReactNode } from 'react'

// Primitives for the Ember Workbench. Every visual decision here traces to
// DESIGN.md; the classes live in app.css so that markup stays free of styling
// arguments and the design system has exactly one home.

type ButtonTone = 'primary' | 'quiet' | 'ghost' | 'danger'

export function Button({
  tone = 'quiet',
  small = false,
  arrow = false,
  children,
  className = '',
  ...rest
}: {
  tone?: ButtonTone
  small?: boolean
  arrow?: boolean
  children: ReactNode
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`btn btn--${tone}${small ? ' btn--small' : ''} ${className}`.trim()}
      {...rest}
    >
      {children}
      {arrow && (
        <span className="btn__arrow" aria-hidden="true">
          ↗
        </span>
      )}
    </button>
  )
}

export function Field({
  label,
  hint,
  error,
  id,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  id: string
  children: ReactNode
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {/* role=alert so a validation failure reaches a screen reader without
          stealing focus from the field the person is still editing. */}
      {error && (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export function TextInput({
  id,
  invalid,
  ...rest
}: { id: string; invalid?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      id={id}
      className="field__input"
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      {...rest}
    />
  )
}

export type LinkStatus = 'active' | 'paused' | 'scheduled' | 'expired'

export function StatusBadge({ status, label }: { status: LinkStatus; label: string }) {
  return <span className={`badge badge--${status}`}>{label}</span>
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>
}

// An ember panel means "the product is speaking". Never behind a table, a form,
// or a list — see the Ember Punctuation Rule in DESIGN.md.
export function EmberPanel({
  children,
  flat = false,
  className = '',
}: {
  children: ReactNode
  flat?: boolean
  className?: string
}) {
  return <div className={`ember${flat ? ' ember--flat' : ''} ${className}`.trim()}>{children}</div>
}

export function Metric({
  value,
  caption,
  note,
}: {
  value: string
  caption: string
  note?: string
}) {
  return (
    <div>
      <div className="t-headline tabular">{value}</div>
      <div className="t-label t-muted" style={{ marginTop: '0.25rem' }}>
        {caption}
      </div>
      {/* The Honest Number Rule: a count that excludes bots says so next to
          itself, rather than quietly disagreeing with the provider's dashboard. */}
      {note && (
        <div className="field__hint" style={{ marginTop: '0.25rem' }}>
          {note}
        </div>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
  script,
}: {
  title: string
  body: string
  action?: ReactNode
  script?: string
}) {
  return (
    <EmberPanel className="reveal">
      <div
        style={{
          padding: 'clamp(2rem, 6vw, 4rem) var(--card-pad)',
          textAlign: 'center',
          display: 'grid',
          gap: '0.875rem',
          justifyItems: 'center',
        }}
      >
        <h2 className="t-headline">
          {title}
          {/* One script word, threshold surfaces only. An empty state qualifies:
              there is nothing to scan yet. */}
          {script && <span className="t-script"> {script}</span>}
        </h2>
        <p className="t-prose" style={{ color: 'var(--on-panel-muted)', maxWidth: '44ch' }}>
          {body}
        </p>
        {action}
      </div>
    </EmberPanel>
  )
}
