// The installer's HTTP surface: a route handler and nothing else.
//
// Deliberately plain `node:http`. A framework that re-renders submitted values
// into HTML — a server action, a form library that echoes state — would put the
// pasted token back on the page, and control 1 is the one control in this design
// that cannot be traded away: the token passes through the visitor's browser, so
// anything that can read that page can read the token before the request leaves.
//
// Hence also: no third-party origin anywhere, fonts served from here, `no-store`
// on every route, and a Content-Security-Policy that names its own origin as the
// only place scripts, styles and fonts may come from.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { FAILURE, ProvisionError, Secret, asProvisionError } from './secret.mjs'
import {
  createJobStore,
  jobView,
  plannedRecords,
  startJob,
  validateInput,
  verifyCredentials,
  COST,
} from './provision.mjs'
import { CLIENT_SCRIPT, renderChallenge, renderPage, resolveLocale, translator } from './page.mjs'

const MAX_BODY_BYTES = 64 * 1024
const JOB_COOKIE = 'linkyard_job'
const CHALLENGE_COOKIE = 'linkyard_challenge'
const CHALLENGE_TTL_MS = 30 * 60 * 1000

// `script-src 'self'` and `default-src 'none'` are the two that matter; the rest
// exist because a directive that falls back to 'none' would block the page's own
// stylesheet and fonts. Nothing here names an origin other than this one.
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

// The challenge page is the single exception, and it is a different page for
// exactly that reason: it loads Cloudflare's widget and holds no credential
// field, so the wider policy costs nothing.
export const CHALLENGE_CSP =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const FONTS = new Set([
  'dm-sans-latin.woff2',
  'dm-sans-latin-ext.woff2',
  'ephesis-latin.woff2',
  'ephesis-latin-ext.woff2',
])

function securityHeaders(csp = CSP) {
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // Nothing this service serves may be cached: the page carries a job's state
    // and a shared cache would hand it to the next visitor.
    'Cache-Control': 'no-store',
  }
}

function parseCookies(header) {
  const jar = {}
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

function cookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ProvisionError(FAILURE.INPUT_INVALID, { field: 'body' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(new ProvisionError(FAILURE.INTERNAL)))
  })
}

function signChallenge(secret, expiresAt) {
  return `${expiresAt}.${createHmac('sha256', secret).update(String(expiresAt)).digest('hex')}`
}

function challengeValid(secret, value, now) {
  const [rawExpiry, signature] = String(value ?? '').split('.')
  const expiresAt = Number(rawExpiry)
  if (!Number.isFinite(expiresAt) || expiresAt < now || !signature) return false
  const expected = createHmac('sha256', secret).update(String(expiresAt)).digest('hex')
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

async function verifyTurnstile(secret, token, deps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: String(token ?? '') }).toString(),
    })
    const body = await response.json().catch(() => ({}))
    return body?.success === true
  } catch {
    return false
  }
}

/**
 * @param {object} options
 * @param {object} options.template the declared topology, i.e. railway-template.json
 * @param {string} [options.turnstileSecret] control 8; absent means the challenge is skipped entirely
 */
// Validated, never coerced: a malformed value makes Number() return NaN, and a
// `>= NaN` comparison is always false — which would remove a ceiling silently,
// from a typo in an environment variable.
function positiveInt(raw, fallback) {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export function createSetupServer({
  template,
  // Validated, not coerced: a malformed value made Number() return NaN, and
  // `occupied() >= NaN` is always false — removing the ceiling entirely, in
  // silence, from a typo in an environment variable.
  store = createJobStore({ maxConcurrent: positiveInt(process.env.MAX_CONCURRENT_JOBS, 3) }),
  deps = {},
  turnstileSecret = process.env.TURNSTILE_SECRET ?? null,
  turnstileSiteKey = process.env.TURNSTILE_SITE_KEY ?? null,
  challengeSecret = process.env.CHALLENGE_SECRET ?? randomBytes(32).toString('hex'),
  assetDir = new URL('../public/', import.meta.url),
  now = () => Date.now(),
} = {}) {
  const turnstileOn = Boolean(turnstileSecret && turnstileSiteKey)

  function send(res, status, headers, body) {
    const payload = body ?? ''
    // `csp` is a routing hint, not a header — only the challenge page overrides
    // the policy, and it must not also emit a header called "csp".
    const { csp, ...rest } = headers
    res.writeHead(status, { ...securityHeaders(csp ?? CSP), ...rest, 'Content-Length': Buffer.byteLength(payload) })
    // A HEAD response carries the headers of the GET and none of its body.
    if (res.req?.method === 'HEAD') res.end()
    else res.end(payload)
  }

  function json(res, status, payload, extraHeaders = {}) {
    send(res, status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }, JSON.stringify(payload))
  }

  function failure(res, status, code, locale) {
    const t = translator(locale)
    // The browser is handed a code from the closed enum and our own sentence for
    // it. Upstream text has no path to this line.
    json(res, status, { code, message: t(`error.${code}`) })
  }

  function localeOf(req, url) {
    return resolveLocale({ query: url.searchParams.get('lang'), acceptLanguage: req.headers['accept-language'] })
  }

  function positiveInt(raw, fallback) {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function jobFromCookie(req) {
    const raw = parseCookies(req.headers.cookie)[JOB_COOKIE]
    const separator = String(raw ?? '').indexOf('.')
    if (separator === -1) return null
    return store.authorize(raw.slice(0, separator), raw.slice(separator + 1))
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://setup.invalid')
    const path = url.pathname
    const locale = localeOf(req, url)
    // A HEAD is a GET whose body is dropped on the way out. Answering 404 to one
    // is what makes a monitor report the whole service down.
    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (path === '/healthz') {
      // The job count is deliberately absent: unauthenticated, it let anyone
      // watch the ceiling fill and time a lockout.
      json(res, 200, { status: 'ok', service: 'linkyard-setup' })
      return
    }

    if (method === 'GET' && path === '/style.css') {
      const css = await readFile(new URL('style.css', assetDir))
      send(res, 200, { 'Content-Type': 'text/css; charset=utf-8' }, css)
      return
    }

    if (method === 'GET' && path === '/app.js') {
      send(res, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }, CLIENT_SCRIPT)
      return
    }

    if (method === 'GET' && path.startsWith('/fonts/')) {
      const name = path.slice('/fonts/'.length)
      // An allow-list, not a path join: the only safe way to serve files by name
      // is to never build a path out of one.
      if (!FONTS.has(name)) {
        send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found')
        return
      }
      const font = await readFile(new URL(`fonts/${name}`, assetDir))
      send(res, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=604800, immutable' }, font)
      return
    }

    if (method === 'GET' && path === '/challenge') {
      if (!turnstileOn) {
        send(res, 302, { Location: '/' })
        return
      }
      send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', csp: CHALLENGE_CSP }, renderChallenge({ locale, siteKey: turnstileSiteKey }))
      return
    }

    if (method === 'POST' && path === '/challenge') {
      if (!turnstileOn) {
        send(res, 302, { Location: '/' })
        return
      }
      const body = new URLSearchParams(await readBody(req))
      const passed = await verifyTurnstile(turnstileSecret, body.get('cf-turnstile-response'), deps)
      if (!passed) {
        send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', csp: CHALLENGE_CSP }, renderChallenge({ locale, siteKey: turnstileSiteKey }))
        return
      }
      send(res, 302, {
        Location: '/',
        'Set-Cookie': cookie(CHALLENGE_COOKIE, signChallenge(challengeSecret, now() + CHALLENGE_TTL_MS), CHALLENGE_TTL_MS / 1000),
      })
      return
    }

    if (method === 'GET' && path === '/') {
      if (turnstileOn && !challengeValid(challengeSecret, parseCookies(req.headers.cookie)[CHALLENGE_COOKIE], now())) {
        send(res, 302, { Location: '/challenge' })
        return
      }
      const running = jobFromCookie(req)
      send(
        res,
        200,
        { 'Content-Type': 'text/html; charset=utf-8' },
        renderPage({ locale, resume: Boolean(running) && running.state !== 'awaiting_confirmation' })
      )
      return
    }

    if (method === 'POST' && path === '/api/verify') {
      if (turnstileOn && !challengeValid(challengeSecret, parseCookies(req.headers.cookie)[CHALLENGE_COOKIE], now())) {
        failure(res, 403, FAILURE.TURNSTILE_FAILED, locale)
        return
      }

      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        failure(res, 400, FAILURE.INPUT_INVALID, locale)
        return
      }

      // One slot per visitor, not one per request.
      //
      // Without this, three POSTs from one client filled the ceiling and every
      // other visitor got 429 for the next half hour — a denial of service
      // costing three HTTP requests. The caller's earlier attempt is also
      // released rather than orphaned: their browser only kept the last cookie,
      // so those jobs were unreachable while still holding two live credentials.
      const previous = jobFromCookie(req)
      if (previous && previous.state !== 'running') store.remove(previous.id)

      let job
      try {
        const input = validateInput(payload)
        const railwayToken = new Secret(String(payload.railwayToken ?? ''))
        const cloudflareToken = new Secret(String(payload.cloudflareToken ?? ''))

        // The slot is claimed before the network calls, so the ceiling counts
        // work in progress rather than work already finished.
        job = store.create({ input, railwayToken, cloudflareToken, locale: input.locale })
        const { account, zone } = await verifyCredentials({ railwayToken, cloudflareToken, input }, deps)
        job.account = account
        job.zone = zone
        job.plannedRecords = plannedRecords(input)
      } catch (error) {
        if (job) store.remove(job.id)
        const problem = error instanceof TypeError ? new ProvisionError(FAILURE.INPUT_INVALID) : asProvisionError(error)
        failure(res, problem.code === FAILURE.TOO_MANY_JOBS ? 429 : 400, problem.code, locale)
        return
      }

      const t = translator(job.locale)
      json(
        res,
        200,
        {
          account: {
            workspace: job.account.workspaceName,
            email: job.account.accountEmail,
            workspaceCount: job.account.workspaceCount,
          },
          zone: { name: job.zone.zoneName, expiresOn: job.zone.expiresOn },
          records: job.plannedRecords,
          cost: COST,
          note: job.account.workspaceCount > 1 ? t('confirm.workspaces') : null,
        },
        // Control 7: the id alone is not a capability. Whoever holds it without
        // this cookie gets nothing — not the status, not the panel address.
        { 'Set-Cookie': cookie(JOB_COOKIE, `${job.id}.${job.secret}`, 1800) }
      )
      return
    }

    if (method === 'POST' && path === '/api/confirm') {
      const job = jobFromCookie(req)
      if (!job) {
        failure(res, 404, FAILURE.JOB_NOT_FOUND, locale)
        return
      }
      try {
        startJob(job, template, deps)
      } catch (error) {
        failure(res, 409, asProvisionError(error).code, locale)
        return
      }
      json(res, 202, { state: job.state })
      return
    }

    if (method === 'GET' && path === '/api/status') {
      const job = jobFromCookie(req)
      if (!job) {
        failure(res, 404, FAILURE.JOB_NOT_FOUND, locale)
        return
      }
      const t = translator(job.locale)
      json(res, 200, {
        ...jobView(job, t),
        strings: {
          doneTitle: t('done.title'),
          doneBody: t('done.body'),
          failedTitle: t('failed.title'),
          failedBody: t('failed.body'),
          manualTitle: t('manual.title'),
          manualBody: t('manual.body'),
          tokenDeleted: t('done.token.deleted'),
          tokenUnconfirmed: t('done.token.unconfirmed'),
        },
      })
      return
    }

    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found')
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      // Whatever it was, the browser gets a code from the enum. A stack trace
      // here would be a stack trace quoting the request that carried the token.
      const problem = asProvisionError(error)
      if (!res.headersSent) failure(res, 500, problem.code, 'en')
      else res.end()
    })
  })

  server.store = store
  return server
}

export async function loadTemplate(url = new URL('../../railway-template.json', import.meta.url)) {
  return JSON.parse(await readFile(url, 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const template = await loadTemplate()
  const server = createSetupServer({ template })
  const port = Number(process.env.PORT ?? 8080)
  server.listen(port, () => console.log(`linkyard setup listening on :${port}`))

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // A redeploy in the middle of a job is the scenario control 5 exists for:
      // exiting now leaves a half-built project nobody can enumerate, so the
      // process stops accepting work and waits for the rollbacks to land.
      server.close(async () => {
        const { drained, timedOut } = await server.store.drain()
        console.log(`setup: drained ${drained} job(s)${timedOut ? ' (timed out)' : ''}`)
        process.exit(0)
      })
    })
  }
}
