// The edge: the process that answers a click.
//
// It is the only component in the visitor's critical path, so it holds no
// dependency it does not need, never serves panel HTML, and keeps working when
// the panel is down. Everything it does on a request is one indexed query and a
// 302; everything else — recording the click, applying scheduled swaps — happens
// off that path.

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { classifyBot } from './bots.mjs'
import {
  clientIp,
  createCollector,
  hashIp,
  parseLanguage,
  parseUserAgent,
  referrerHost,
  resolveIpSalt,
} from './collect.mjs'
import { createHostCache, lookupHost, normalizeHost, resolveRequest } from './resolve.mjs'
import {
  FAVICON,
  notFoundPage,
  robotsTxt,
  rootDecision,
  rootPage,
  securityHeaders,
  securityTxt,
} from './root.mjs'

const SCHEDULER_INTERVAL_MS = 60_000

function splitUrl(rawUrl) {
  const url = rawUrl || '/'
  const mark = url.indexOf('?')
  return mark === -1 ? { pathname: url, search: '' } : { pathname: url.slice(0, mark), search: url.slice(mark) }
}

/**
 * @param {object} options
 * @param {import('pg').Pool} options.pool
 * @param {ReturnType<typeof createCollector>} [options.collector]
 * @param {string} [options.securityContact] populates /.well-known/security.txt; the file is omitted without it
 * @param {string} [options.ipSalt] HMAC salt for the client address
 * @param {boolean} [options.trustProxy] read X-Forwarded-For (both install targets sit behind a proxy)
 */
export function createEdgeServer({
  pool,
  collector = createCollector({ pool }),
  cache = createHostCache({ ttlMs: Number(process.env.HOST_CACHE_TTL_MS ?? 30_000) }),
  securityContact = process.env.SECURITY_CONTACT,
  ipSalt = resolveIpSalt(),
  trustProxy = process.env.TRUST_PROXY !== '0',
} = {}) {
  function send(req, res, status, headers, body) {
    const https = (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0].trim() === 'https'
    const payload = body === undefined || body === null ? '' : body
    const length = Buffer.byteLength(payload)
    res.writeHead(status, {
      ...securityHeaders({ https }),
      ...headers,
      'Content-Length': length,
    })
    // A HEAD response carries the headers of the GET and none of its body.
    if (req.method === 'HEAD' || !length) res.end()
    else res.end(payload)
  }

  function redirect(req, res, status, location) {
    send(req, res, status, {
      Location: location,
      // no-store, and this is the single most important header in the service.
      // A cached redirect — which is exactly what a 301 asks for — means the
      // next destination swap never reaches anyone who already clicked, and
      // "change the destination, keep the URL" is the entire product.
      'Cache-Control': 'no-store',
    })
  }

  function html(req, res, status, body) {
    send(req, res, status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body)
  }

  async function handle(req, res) {
    const startedAt = process.hrtime.bigint()
    const host = normalizeHost(req.headers.host)
    const { pathname, search } = splitUrl(req.url)

    // `health` is the reserved slug in the schema; `healthz` is the name every
    // platform probe defaults to. Both answer, so neither a platform default nor
    // the schema's reservation is a path a link could shadow.
    if (pathname === '/healthz' || pathname === '/health') {
      // The probe touches the database on purpose. A health check that only
      // proves the process is running will keep a replica in rotation while
      // every redirect hangs on a database that stopped answering — the
      // failure mode this endpoint exists to catch.
      let dbOk = true
      try {
        await pool.query('SELECT 1')
      } catch {
        dbOk = false
      }
      send(
        req,
        res,
        dbOk ? 200 : 503,
        { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify({
          status: dbOk ? 'ok' : 'degraded',
          database: dbOk,
          service: 'linkyard-edge',
          time: new Date().toISOString(),
        })
      )
      return
    }

    if (pathname === '/robots.txt') {
      send(req, res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, robotsTxt())
      return
    }

    if (pathname === '/favicon.ico') {
      send(req, res, 200, { 'Content-Type': FAVICON.contentType, 'Cache-Control': 'public, max-age=86400' }, FAVICON.body)
      return
    }

    if (pathname === '/.well-known/security.txt') {
      const body = securityTxt(securityContact)
      if (!body) {
        html(req, res, 404, notFoundPage(host))
        return
      }
      send(req, res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, body)
      return
    }

    if (pathname === '/' || pathname === '') {
      const site = await lookupHost(pool, host, cache)
      const decision = rootDecision(site)
      if (decision.type === 'redirect') redirect(req, res, 302, decision.location)
      else html(req, res, 200, rootPage(host, site?.apex ?? null))
      return
    }

    const outcome = await resolveRequest(pool, { host, pathname, search }, cache)

    if (outcome.type === 'redirect') {
      redirect(req, res, outcome.status, outcome.location)
    } else if (outcome.type === 'root') {
      const decision = rootDecision(outcome.site)
      if (decision.type === 'redirect') redirect(req, res, 302, decision.location)
      else html(req, res, 200, rootPage(host, outcome.site?.apex ?? null))
      return
    } else {
      html(req, res, 404, notFoundPage(host, outcome.site?.apex ?? null))
    }

    // Everything below runs with the response already on the wire.
    if (!outcome.linkId) return

    const bot = classifyBot(req.headers['user-agent'])
    const agent = parseUserAgent(req.headers['user-agent'])

    // The address is resolved once and handed over BOTH ways: hashed for the
    // stored column, and raw for the geolocation lookup the collector runs
    // after the response is already sent. Passing only the hash meant the geo
    // lookup short-circuited on a missing `ip` and silently never ran — every
    // country column null in an installation that had configured MaxMind and
    // had no way to tell why.
    const ip = clientIp(req, { trustProxy })

    collector.record({
      linkId: outcome.linkId,
      occurredAt: new Date(),
      ip,
      ipHash: hashIp(ip, ipSalt),
      device: bot.isBot ? 'bot' : agent.device,
      os: agent.os,
      browser: agent.browser,
      language: parseLanguage(req.headers['accept-language']),
      referrerHost: referrerHost(req.headers.referer),
      referrerFull: Array.isArray(req.headers.referer) ? req.headers.referer[0] : req.headers.referer,
      isBot: bot.isBot,
      botKind: bot.kind,
      finalUrl: outcome.type === 'redirect' ? outcome.location : null,
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('edge:', err?.message ?? err)
      // Even a failure is branded. A raw stack or a text/plain 500 is what makes
      // a domain look abandoned to the scanners this service is built to please.
      if (!res.headersSent) {
        html(req, res, 500, notFoundPage(normalizeHost(req.headers.host)))
      } else {
        res.end()
      }
    })
  })

  server.on('close', () => cache.clear())
  return server
}

/**
 * Scheduled destination swaps.
 *
 * They run here because the edge is the process that runs continuously; the
 * panel may be asleep, restarting, or scaled to zero. The executor itself is
 * the panel's — `FOR UPDATE SKIP LOCKED` makes a second runner harmless, so a
 * second replica is a correctness question the executor already answered, and
 * RUN_SCHEDULER=0 exists only to keep the log quiet on replicas that need not
 * bother.
 */
export function startScheduler(pool, intervalMs = SCHEDULER_INTERVAL_MS) {
  let running = false
  const tick = async () => {
    // A tick that outlasts its interval must not stack on itself.
    if (running) return
    running = true
    try {
      const { runDueSchedules } = await import('../../panel/app/lib/schedules.server.ts')
      const { applied, failed } = await runDueSchedules(pool)
      if (applied || failed) console.log(`scheduler: ${applied} applied, ${failed} failed`)
    } catch (err) {
      // A scheduler that throws must not take the redirect service with it.
      console.error('scheduler:', err?.message ?? err)
    }

    // The rollup rides the same tick, for the same reason the scheduler does:
    // this is the process that stays up. Without it, click_events fills with
    // real clicks and click_daily — the only table the reports read — stays
    // empty, so the panel shows zero while the traffic is right there.
    //
    // Its own try/catch: a rollup failure must not stop schedules from firing.
    try {
      const { rollupRecent } = await import('../../panel/app/lib/rollup.server.ts')
      await rollupRecent(2)
    } catch (err) {
      console.error('rollup:', err?.message ?? err)
    } finally {
      running = false
    }
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function sslFor(connectionString) {
  // SSL is opt-in through the connection string, never guessed. Guessing "not
  // localhost, therefore TLS" breaks Railway's private network, which speaks
  // plain TCP inside the project and rejects the handshake outright.
  if (/[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)) {
    return { rejectUnauthorized: false }
  }
  return undefined
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  // Timeouts on every leg of the visitor's path.
  //
  // Without them, a Postgres that stops answering WITHOUT closing the socket —
  // a failover, a partition with no RST, a lock pile-up — leaves pool.query
  // pending forever. The handler never resolves, nothing is ever written to the
  // response, and the catch that renders the branded 500 never fires: the
  // visitor gets a spinning tab, which is worse than an error page. After `max`
  // such requests the pool is exhausted and every later request hangs too,
  // while a healthcheck that queries nothing keeps answering 200 and holds the
  // dead replica in rotation.
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    ssl: sslFor(connectionString),
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    statement_timeout: 2000,
  })
  const collector = createCollector({ pool })
  const server = createEdgeServer({ pool, collector })
  const port = Number(process.env.PORT ?? 8080)

  server.listen(port, () => console.log(`linkyard edge listening on :${port}`))

  const stopScheduler = process.env.RUN_SCHEDULER === '0' ? null : startScheduler(pool)

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      stopScheduler?.()
      server.close(async () => {
        // Buffered clicks are written before the process goes: a deploy is the
        // most predictable moment to lose a batch, and the cheapest to avoid.
        await collector.stop()
        await pool.end()
        process.exit(0)
      })
    })
  }
}
