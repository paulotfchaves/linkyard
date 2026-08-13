import { Form, NavLink } from 'react-router'
import type { ReactNode } from 'react'

// The app shell: an ember top bar over the light working surface.
//
// Navigation is horizontal, not a sidebar. The product has six destinations,
// and a sidebar would spend 240px of a data table's width on six words.
//
// This component takes everything it renders as props and imports no server
// module, so it stays renderable in isolation and the routes own the wiring.

export type NavItem = { to: string; label: string; end?: boolean }

export type ShellUser = {
  username: string
  email: string
  role: string
}

export function Shell({
  user,
  nav,
  locale,
  localeLabel,
  signOutLabel,
  accountLabel,
  children,
}: {
  user: ShellUser
  nav: NavItem[]
  locale: string
  localeLabel: string
  signOutLabel: string
  accountLabel: string
  children: ReactNode
}) {
  const otherLocale = locale === 'pt-BR' ? 'en' : 'pt-BR'

  return (
    <>
      <header className="ember shell__bar">
        <span className="wordmark" aria-label="Linkyard">
          <span className="wordmark__glyph" aria-hidden="true" />
          Linkyard
        </span>

        <nav className="shell__nav" aria-label={accountLabel}>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `shell__link${isActive ? ' is-active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="shell__account">
          {/* Locale is a form post, not a client toggle: the choice belongs to
              the user row, so it survives a different browser. */}
          <Form method="post" action="/locale">
            <input type="hidden" name="locale" value={otherLocale} />
            <input type="hidden" name="returnTo" value="" />
            <button type="submit" className="shell__locale" title={localeLabel}>
              {otherLocale === 'pt-BR' ? 'PT' : 'EN'}
            </button>
          </Form>

          <span className="shell__user" title={user.email}>
            {user.username}
          </span>

          <Form method="post" action="/logout">
            <button type="submit" className="shell__signout">
              {signOutLabel}
            </button>
          </Form>
        </div>
      </header>

      <main className="shell__main">{children}</main>
    </>
  )
}

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string
  lead?: string
  actions?: ReactNode
}) {
  return (
    <div className="page-header">
      <div>
        <h1 className="t-headline">{title}</h1>
        {lead && (
          <p className="t-muted" style={{ marginTop: '0.375rem' }}>
            {lead}
          </p>
        )}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  )
}
