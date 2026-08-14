import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Secret } from '@linkyard/core/secret'
import {
  CloudflareDns,
  assertZoneScope,
  resolveZoneSet,
  type ScopeVerdict,
} from '../app/lib/dns/cloudflare.ts'
import { ProviderError } from '../app/lib/infra/types.ts'

// The token used everywhere below. Every assertion that matters about secrecy
// looks for this exact string: if it ever reaches an error message, the test
// that finds it is the one that would have found it in a production log.
const SENTINEL = 'cf-tok-SENTINEL-must-never-be-printed'

const ZONE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OTHER_ZONE = '0f9e8d7c6b5a493827160f5e4d3c2b1a'
const TOKEN_ID = 'ffffffffffffffffffffffffffffffff'

type Call = { method: string; url: string; auth: string | null; body: unknown }

const realFetch = globalThis.fetch
let calls: Call[] = []

/** Answers a request by matching on method and path; anything unmatched is a 404 envelope. */
function stubFetch(routes: Record<string, () => { status?: number; body: unknown }>): void {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      method,
      url,
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })

    const path = new URL(url).pathname
    const route = routes[`${method} ${path}`] ?? routes[path]
    if (!route) {
      return new Response(
        JSON.stringify({ success: false, result: null, errors: [{ code: 7003, message: 'no route' }] }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    }
    const { status = 200, body } = route()
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function ok(result: unknown, extra: Record<string, unknown> = {}) {
  return { body: { success: true, result, errors: [], ...extra } }
}

function provider(): CloudflareDns {
  return new CloudflareDns(new Secret(SENTINEL))
}

function verifyRoute(overrides: Record<string, unknown> = {}) {
  return () => ok({ id: TOKEN_ID, status: 'active', expires_on: null, ...overrides })
}

function zonePolicy(zoneId: string) {
  return {
    effect: 'allow',
    resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: '*' },
    permission_groups: [{ name: 'DNS Write' }, { name: 'Zone Read' }],
  }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

// ------------------------------------------------------------- token identity

describe('verifyToken', () => {
  it('reads the three fields the verify endpoint actually returns', async () => {
    stubFetch({
      '/client/v4/user/tokens/verify': verifyRoute({ expires_on: '2026-09-01T00:00:00Z' }),
    })

    const identity = await provider().verifyToken()

    assert.deepEqual(identity, {
      id: TOKEN_ID,
      status: 'active',
      expiresOn: '2026-09-01T00:00:00Z',
    })
    assert.equal(calls[0].auth, `Bearer ${SENTINEL}`)
  })

  it('reports a rejected token as unauthorized without quoting the token', async () => {
    stubFetch({
      '/client/v4/user/tokens/verify': () => ({
        status: 401,
        body: { success: false, result: null, errors: [{ code: 1000, message: 'Invalid API Token' }] },
      }),
    })

    const error = await provider()
      .verifyToken()
      .catch((err: unknown) => err)

    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'unauthorized')
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(SENTINEL))
  })
})

// ---------------------------------------------------------------- token scope

describe('tokenScope', () => {
  it('reads the zone set from the token policies when the token can read itself', async () => {
    stubFetch({
      '/client/v4/user/tokens/verify': verifyRoute(),
      [`/client/v4/user/tokens/${TOKEN_ID}`]: () =>
        ok({
          id: TOKEN_ID,
          status: 'active',
          expires_on: '2026-08-15T00:00:00Z',
          policies: [zonePolicy(ZONE)],
        }),
    })

    const scope = await provider().tokenScope()

    assert.deepEqual(scope.zones, [ZONE])
    assert.deepEqual(scope.permissions, ['DNS Write', 'Zone Read'])
    assert.equal(scope.expiresOn, '2026-08-15T00:00:00Z')
    assert.equal(scope.source, 'policies')
  })

  it('reads an account-wide policy as every zone', async () => {
    stubFetch({
      '/client/v4/user/tokens/verify': verifyRoute(),
      [`/client/v4/user/tokens/${TOKEN_ID}`]: () =>
        ok({
          id: TOKEN_ID,
          status: 'active',
          expires_on: null,
          policies: [
            {
              effect: 'allow',
              resources: {
                'com.cloudflare.api.account.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
                  'com.cloudflare.api.account.zone.*': '*',
                },
              },
              permission_groups: [{ name: 'DNS Write' }],
            },
          ],
        }),
    })

    const scope = await provider().tokenScope()

    assert.equal(scope.zones, 'all')
    assert.equal(scope.source, 'policies')
  })

  it('falls back to the zone listing when the token may not read its own detail', async () => {
    // The common case in practice: reading /user/tokens/{id} needs a permission
    // a DNS token has no reason to carry, so the scope has to be inferred from
    // what the token can actually see.
    stubFetch({
      '/client/v4/user/tokens/verify': verifyRoute(),
      [`/client/v4/user/tokens/${TOKEN_ID}`]: () => ({
        status: 403,
        body: {
          success: false,
          result: null,
          errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
        },
      }),
      '/client/v4/zones': () =>
        ok([{ id: ZONE, name: 'example.com', account: { id: 'acc', name: 'Personal' } }], {
          result_info: { page: 1, total_pages: 1 },
        }),
    })

    const scope = await provider().tokenScope()

    assert.deepEqual(scope.zones, [ZONE])
    assert.equal(scope.source, 'zone_listing')
    assert.deepEqual(scope.permissions, [])
  })
})

// ----------------------------------------------------------- the scope gate

describe('resolveZoneSet', () => {
  it('treats a resource shape it does not recognise as unbounded', () => {
    // Failing open here would mean a policy Cloudflare adds next year silently
    // passes the gate. Unknown breadth is refused, not assumed narrow.
    const zones = resolveZoneSet([
      { effect: 'allow', resources: { 'com.cloudflare.api.something.new': '*' } },
    ])
    assert.equal(zones, 'all')
  })

  it('ignores a deny policy when widening', () => {
    const zones = resolveZoneSet([
      zonePolicy(ZONE),
      { effect: 'deny', resources: { [`com.cloudflare.api.account.zone.${OTHER_ZONE}`]: '*' } },
    ])
    assert.deepEqual(zones, [ZONE])
  })
})

/** Narrows to the refusal, and fails the test if the gate let it through. */
function refusal(verdict: ScopeVerdict): Exclude<ScopeVerdict, { ok: true }> {
  if (verdict.ok) assert.fail('expected the scope gate to refuse')
  return verdict
}

describe('assertZoneScope', () => {
  const scoped = {
    zones: [ZONE],
    permissions: ['DNS Write', 'Zone Read'],
    expiresOn: null,
    source: 'policies' as const,
  }

  it('accepts a token scoped to exactly the target zone', () => {
    assert.deepEqual(assertZoneScope(scoped, ZONE), { ok: true })
  })

  it('refuses an all-zones token', () => {
    // The whole point of this task. Such a token carries DNS edit over every
    // domain the person owns — enough to repoint their MX and read their mail.
    const verdict = refusal(assertZoneScope({ ...scoped, zones: 'all' }, ZONE))
    assert.equal(verdict.reason, 'all_zones')
  })

  it('refuses a token that reaches the target zone plus others', () => {
    const verdict = refusal(assertZoneScope({ ...scoped, zones: [ZONE, OTHER_ZONE] }, ZONE))
    assert.equal(verdict.reason, 'extra_zones')
    assert.deepEqual(verdict.reason === 'extra_zones' ? verdict.zones : null, [ZONE, OTHER_ZONE])
  })

  it('refuses a token that cannot reach the target zone at all', () => {
    const verdict = refusal(assertZoneScope({ ...scoped, zones: [OTHER_ZONE] }, ZONE))
    assert.equal(verdict.reason, 'wrong_zone')
  })

  it('names the permission that is missing rather than saying no', () => {
    const verdict = refusal(assertZoneScope({ ...scoped, permissions: ['Zone Read'] }, ZONE))
    assert.equal(verdict.reason, 'missing_permission')
    assert.deepEqual(verdict.reason === 'missing_permission' ? verdict.missing : null, ['dns_edit'])
  })

  it('does not judge permissions it could not read', () => {
    // A listing-derived scope carries no permission names. Refusing it for a
    // missing permission would refuse every correctly scoped token in practice.
    const verdict = assertZoneScope(
      { zones: [ZONE], permissions: [], expiresOn: null, source: 'zone_listing' },
      ZONE
    )
    assert.deepEqual(verdict, { ok: true })
  })
})

// -------------------------------------------------------------------- records

describe('records', () => {
  it('never asks Cloudflare to proxy a record', async () => {
    stubFetch({
      [`POST /client/v4/zones/${ZONE}/dns_records`]: () =>
        ok({ id: 'rec1', type: 'CNAME', name: 'go.example.com', content: 'x.up.railway.app', proxied: false, ttl: 1 }),
    })

    await provider().createRecord(ZONE, {
      type: 'CNAME',
      name: 'go.example.com',
      content: 'x.up.railway.app',
    })

    const body = calls[0].body as { proxied: unknown; ttl: unknown }
    assert.equal(body.proxied, false)
    assert.equal(body.ttl, 1)
  })

  it('refuses a zone id that is not a Cloudflare zone id before it reaches a URL', async () => {
    stubFetch({})

    const error = await provider()
      .findRecords('../../user/tokens', 'go.example.com')
      .catch((err: unknown) => err)

    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'invalid_input')
    assert.equal(calls.length, 0, 'a malformed zone id must not produce a request')
  })

  it('asks for records at exactly the host, not below it', async () => {
    stubFetch({
      [`/client/v4/zones/${ZONE}/dns_records`]: () =>
        ok([
          { id: 'r1', type: 'A', name: 'go.example.com', content: '203.0.113.7', proxied: true, ttl: 1 },
        ]),
    })

    const records = await provider().findRecords(ZONE, 'go.example.com')

    const asked = new URL(calls[0].url)
    assert.equal(asked.searchParams.get('name'), 'go.example.com')
    assert.deepEqual(records, [
      { id: 'r1', type: 'A', name: 'go.example.com', content: '203.0.113.7', proxied: true, ttl: 1 },
    ])
  })

  it('walks every page of the zone listing', async () => {
    let page = 0
    stubFetch({
      '/client/v4/zones': () => {
        page += 1
        return ok([{ id: page === 1 ? ZONE : OTHER_ZONE, name: `z${page}.example`, account: null }], {
          result_info: { page, total_pages: 2 },
        })
      },
    })

    const zones = await provider().listZones()

    assert.equal(zones.length, 2)
    assert.deepEqual(
      zones.map((zone) => zone.id),
      [ZONE, OTHER_ZONE]
    )
  })

  it('deletes by record id', async () => {
    stubFetch({
      [`DELETE /client/v4/zones/${ZONE}/dns_records/rec1`]: () => ok({ id: 'rec1' }),
    })

    await provider().deleteRecord(ZONE, 'rec1')

    assert.equal(calls[0].method, 'DELETE')
    assert.ok(calls[0].url.endsWith(`/zones/${ZONE}/dns_records/rec1`))
  })

  it('keeps the token out of the error it raises when a write is refused', async () => {
    stubFetch({
      [`POST /client/v4/zones/${ZONE}/dns_records`]: () => ({
        status: 400,
        body: {
          success: false,
          result: null,
          errors: [{ code: 81057, message: 'Record already exists.' }],
        },
      }),
    })

    const error = await provider()
      .createRecord(ZONE, { type: 'TXT', name: '_railway-verify.go.example.com', content: 'abc' })
      .catch((err: unknown) => err)

    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'api_error')
    assert.match(error.message, /Record already exists/)
    assert.ok(!error.message.includes(SENTINEL))
  })

  it('reports a transport failure as network rather than crashing', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch

    const error = await provider()
      .listZones()
      .catch((err: unknown) => err)

    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'network')
  })
})
