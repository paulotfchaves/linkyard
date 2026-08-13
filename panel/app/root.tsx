import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import type { LinksFunction } from 'react-router'

import tokens from './styles/tokens.css?url'
import app from './styles/app.css?url'

export const links: LinksFunction = () => [
  { rel: 'stylesheet', href: tokens },
  { rel: 'stylesheet', href: app },
  { rel: 'preload', href: '/fonts/dm-sans-latin.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
]

// Motion is opt-in, mirroring the portfolio: the document renders fully static
// and this script flips it on. Anything that animates is gated behind
// html[data-motion="enhanced"], so a person with JavaScript off — or with
// prefers-reduced-motion — gets a still interface rather than a broken one.
const ENABLE_MOTION = `
try {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.dataset.motion = 'enhanced'
  }
} catch (e) {}
`

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
        <script dangerouslySetInnerHTML={{ __html: ENABLE_MOTION }} />
      </body>
    </html>
  )
}

export default function Root() {
  return <Outlet />
}
