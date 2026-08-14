import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSetupServer, CSP } from '../src/server.mjs'
import { createJobStore, validateInput } from '../src/provision.mjs'
import { DICTIONARIES, en, ptBR } from '../src/page.mjs'
import { FAILURE } from '../src/secret.mjs'

const TEMPLATE = { services: [] }

const FORM = {
  email: 'owner@example.com',
  password: 'a-long-enough-password',
  apex: 'example.com',
  panelHost: 'links',
  redirectHost: 'go',
  locale: 'en',
  timezone: 'UTC',
  railwayToken: 'rw-sentinel-1c3f-never-printed-ee54',
  cloudflareToken: 'cf-sentinel-never-printed',
}

const PROVIDERS = {
  railway: {
    async resolveAccount() {
      return { accountEmail: 'owner@example.com', accountName: 'Owner', workspaceId: 'w1', workspaceName: 'Personal', workspaceCount: 1 }
    },
  },
  cloudflare: {
    async inspectCredential() {
      return { zoneId: 'z1', zoneName: 'example.com', expiresOn: '2026-08-15T00:00:00Z' }
    },
  },
}

async function withServer(options, run) {
  const server = createSetupServer({ template: TEMPLATE, ...options })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base, server)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const cookieFrom = (response) =>
  response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ')

test('the installer route carries the policy that makes the model survivable', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const response = await fetch(base)
    const policy = response.headers.get('content-security-policy')

    for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
      assert.ok(policy.includes(directive), `missing ${directive}`)
    }
    assert.equal(policy, CSP)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    // The per-route policy travels as an internal hint, never as a header of
    // its own.
    assert.equal(response.headers.get('csp'), null)

    // A monitor that HEADs the page must not read the whole service as down.
    const head = await fetch(base, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-security-policy'), CSP)
  })
})

test('the page loads nothing from anywhere else', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const html = await (await fetch(base)).text()

    const subresources = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((match) => match[1])
    assert.ok(subresources.length > 0)
    for (const url of subresources) {
      assert.ok(url.startsWith('/'), `third-party subresource on the credential route: ${url}`)
    }

    const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8')
    assert.equal(/url\(\s*["']?https?:/i.test(css), false, 'the stylesheet reaches off-origin')
  })
})

test('both credential fields are passwords that no manager fills in', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const html = await (await fetch(base)).text()

    for (const id of ['railwayToken', 'cloudflareToken']) {
      const field = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)
      assert.ok(field, `${id} is missing`)
      assert.match(field[0], /type="password"/)
      assert.match(field[0], /autocomplete="off"/)
    }
    // And the script that clears them once the request is on its way.
    const script = await (await fetch(`${base}/app.js`)).text()
    assert.match(script, /#railwayToken'\)\.value = ''/)
    assert.match(script, /#cloudflareToken'\)\.value = ''/)
  })
})

test('the three sentences the spec makes mandatory are on the page, in both languages', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const english = await (await fetch(`${base}/?lang=en`)).text()
    assert.ok(english.includes('US$ 5.50'), 'the cost is not stated before the button')
    assert.ok(english.includes('Hobby plan does not cover it'))
    assert.ok(english.includes('We keep your email address and the date'))
    assert.ok(english.includes('only ever asks for a token at this address'))
    assert.ok(english.includes('We delete it automatically'))

    const portuguese = await (await fetch(`${base}/?lang=pt-BR`)).text()
    assert.ok(portuguese.includes('não cobre'))
    assert.ok(portuguese.includes('só pede token neste endereço'))
    assert.ok(portuguese.includes('Vamos apagá-lo automaticamente'))
    assert.ok(portuguese.includes('validade de 1 dia'))
  })
})

test('the phases are named in human language, never by their enum', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const html = await (await fetch(base)).text()
    assert.ok(html.includes('Creating your panel'))
    assert.ok(html.includes('Configuring the address'))
    assert.ok(html.includes('Deleting your token'))

    const portuguese = await (await fetch(`${base}/?lang=pt-BR`)).text()
    assert.ok(portuguese.includes('Criando seu painel'))
    assert.ok(portuguese.includes('Apagando seu token'))
  })
})

test('the two dictionaries hold the same keys', () => {
  const english = Object.keys(en).sort()
  const brazilian = Object.keys(ptBR).sort()
  assert.deepEqual(brazilian, english)
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), ['en', 'pt-BR'])

  for (const code of Object.values(FAILURE)) {
    assert.ok(en[`error.${code}`], `English has no sentence for ${code}`)
    assert.ok(ptBR[`error.${code}`], `Portuguese has no sentence for ${code}`)
  }
})

test('verify resolves the account and the zone, and binds the job to a cookie', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const response = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FORM),
    })
    assert.equal(response.status, 200)

    const [cookie] = response.headers.getSetCookie()
    assert.match(cookie, /^linkyard_job=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    assert.match(cookie, /Secure/)

    const body = await response.json()
    assert.equal(body.account.workspace, 'Personal')
    assert.equal(body.zone.name, 'example.com')
    assert.deepEqual(body.records.map((record) => `${record.type} ${record.name}`), [
      'CNAME links.example.com',
      'TXT _railway-verify.links.example.com',
      'CNAME go.example.com',
      'TXT _railway-verify.go.example.com',
    ])
    assert.equal(body.cost.hobbyPlanUsd, 5)
    assert.equal(JSON.stringify(body).includes(FORM.railwayToken), false)
  })
})

test('a refused credential answers with a code and our own sentence', async () => {
  const deps = {
    railway: {
      async resolveAccount() {
        throw Object.assign(new Error('upstream said: token abc123 is not authorized'), { code: FAILURE.RAILWAY_TOKEN_NOT_ACCOUNT })
      },
    },
    cloudflare: PROVIDERS.cloudflare,
  }

  await withServer({ deps }, async (base) => {
    const response = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FORM),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    // A plain Error is not a ProvisionError, so it lands on `internal` rather
    // than carrying its message to the browser.
    assert.equal(body.code, FAILURE.INTERNAL)
    assert.equal(body.message, en[`error.${FAILURE.INTERNAL}`])
    assert.equal(JSON.stringify(body).includes('abc123'), false)
  })
})

test('a form that is not valid never reaches an API', async () => {
  let touched = false
  const deps = {
    railway: {
      async resolveAccount() {
        touched = true
        return {}
      },
    },
    cloudflare: PROVIDERS.cloudflare,
  }

  await withServer({ deps }, async (base) => {
    const response = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...FORM, panelHost: 'www' }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, FAILURE.DNS_NAME_FORBIDDEN)
    assert.equal(touched, false)
  })
})

test('the ceiling answers 429 instead of taking the process down', async () => {
  await withServer({ deps: PROVIDERS, store: createJobStore({ maxConcurrent: 1 }) }, async (base) => {
    const send = () =>
      fetch(`${base}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(FORM),
      })

    assert.equal((await send()).status, 200)
    const second = await send()
    assert.equal(second.status, 429)
    assert.equal((await second.json()).code, FAILURE.TOO_MANY_JOBS)
  })
})

test('status and confirm are shut without the cookie, and open with it', async () => {
  const store = createJobStore()
  await withServer({ deps: PROVIDERS, store }, async (base) => {
    const bare = await fetch(`${base}/api/status`)
    assert.equal(bare.status, 404)
    assert.equal((await bare.json()).code, FAILURE.JOB_NOT_FOUND)

    const verified = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FORM),
    })
    const cookie = cookieFrom(verified)
    const [id] = decodeURIComponent(cookie.split('=')[1]).split('.')

    // The id alone — the part that travels in URLs and logs — opens nothing.
    const guessed = await fetch(`${base}/api/status`, { headers: { cookie: `linkyard_job=${id}.deadbeef` } })
    assert.equal(guessed.status, 404)

    const authorized = await fetch(`${base}/api/status`, { headers: { cookie } })
    assert.equal(authorized.status, 200)
    const view = await authorized.json()
    assert.equal(view.state, 'awaiting_confirmation')
    assert.deepEqual(view.phases.map((phase) => phase.label)[1], 'Creating your panel')
    assert.equal(view.strings.doneTitle, en['done.title'])

    const confirmWithout = await fetch(`${base}/api/confirm`, { method: 'POST' })
    assert.equal(confirmWithout.status, 404)
  })
})

test('reloading during an install comes back to the progress view', async () => {
  const store = createJobStore()
  await withServer({ deps: PROVIDERS, store }, async (base) => {
    const verified = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FORM),
    })
    const cookie = cookieFrom(verified)

    // Still on the confirmation screen: a reload belongs on the form.
    const beforeConfirm = await (await fetch(base, { headers: { cookie } })).text()
    assert.equal(beforeConfirm.includes('data-resume="progress"'), false)

    const [id] = decodeURIComponent(cookie.split('=')[1]).split('.')
    store.get(id).state = 'running'

    const during = await (await fetch(base, { headers: { cookie } })).text()
    assert.ok(during.includes('data-resume="progress"'))
    // And without the cookie there is nothing to resume.
    assert.equal((await (await fetch(base)).text()).includes('data-resume'), false)
  })
})

test('the status of a pt-BR job speaks Portuguese regardless of the request', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const verified = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...FORM, locale: 'pt-BR' }),
    })
    const view = await (await fetch(`${base}/api/status`, { headers: { cookie: cookieFrom(verified), 'accept-language': 'en' } })).json()
    assert.equal(view.phases[6].label, 'Apagando seu token')
  })
})

test('Turnstile is skipped cleanly when it is not configured', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    assert.equal((await fetch(base, { redirect: 'manual' })).status, 200)
    const response = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FORM),
    })
    assert.equal(response.status, 200)
  })
})

test('with Turnstile configured the challenge happens on a page that holds no credential', async () => {
  const deps = {
    ...PROVIDERS,
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true }) }),
  }

  await withServer(
    { deps, turnstileSecret: 'secret', turnstileSiteKey: 'site-key', challengeSecret: 'challenge-secret' },
    async (base) => {
      const gated = await fetch(base, { redirect: 'manual' })
      assert.equal(gated.status, 302)
      assert.equal(gated.headers.get('location'), '/challenge')

      const refused = await fetch(`${base}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(FORM),
      })
      assert.equal(refused.status, 403)
      assert.equal((await refused.json()).code, FAILURE.TURNSTILE_FAILED)

      const challenge = await fetch(`${base}/challenge`)
      const html = await challenge.text()
      assert.match(challenge.headers.get('content-security-policy'), /challenges\.cloudflare\.com/)
      assert.ok(html.includes('cf-turnstile'))
      assert.equal(/type="password"/.test(html), false, 'the challenge page must never hold a credential field')

      const passed = await fetch(`${base}/challenge`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'cf-turnstile-response=token',
      })
      assert.equal(passed.status, 302)
      const cookie = cookieFrom(passed)
      assert.match(cookie, /^linkyard_challenge=/)

      const allowed = await fetch(base, { headers: { cookie }, redirect: 'manual' })
      assert.equal(allowed.status, 200)
      // And the installer page itself still refuses every outside origin.
      assert.equal((await allowed.text()).includes('challenges.cloudflare.com'), false)
    }
  )
})

test('a forged challenge cookie does not open the form', async () => {
  const deps = { ...PROVIDERS, fetchImpl: async () => ({ ok: true, json: async () => ({ success: true }) }) }
  await withServer({ deps, turnstileSecret: 'secret', turnstileSiteKey: 'site-key', challengeSecret: 'challenge-secret' }, async (base) => {
    const forged = `linkyard_challenge=${encodeURIComponent(`${Date.now() + 60_000}.${'0'.repeat(64)}`)}`
    const response = await fetch(base, { headers: { cookie: forged }, redirect: 'manual' })
    assert.equal(response.status, 302)
  })
})

test('fonts come from here, by name, and nothing else does', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const font = await fetch(`${base}/fonts/dm-sans-latin.woff2`)
    assert.equal(font.status, 200)
    assert.equal(font.headers.get('content-type'), 'font/woff2')

    assert.equal((await fetch(`${base}/fonts/../src/server.mjs`)).status, 404)
    assert.equal((await fetch(`${base}/fonts/anything-else.woff2`)).status, 404)
    assert.equal((await fetch(`${base}/wp-admin`)).status, 404)
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 404)
  })
})

test('an oversized body is refused rather than buffered', async () => {
  await withServer({ deps: PROVIDERS }, async (base) => {
    const response = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...FORM, note: 'x'.repeat(70 * 1024) }),
    }).catch(() => ({ status: 400 }))
    assert.notEqual(response.status, 200)
  })
})

test('the health route does not report how many jobs are in flight', async () => {
  // The count was removed rather than kept. Unauthenticated, it let anyone
  // watch the concurrency ceiling fill and time the moment the installer stops
  // accepting work — a reconnaissance signal for the denial of service it was
  // reporting on.
  const store = createJobStore()
  await withServer({ deps: PROVIDERS, store }, async (base) => {
    const body = await (await fetch(`${base}/healthz`)).json()
    assert.deepEqual(body, { status: 'ok', service: 'linkyard-setup' })
    assert.ok(!('jobs' in body), 'the job count must not be exposed')
    assert.doesNotThrow(() => validateInput(FORM))
  })
})
