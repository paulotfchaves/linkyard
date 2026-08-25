import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { Pool } from 'pg'
import { projectCost, sampleUsage, usageStatus } from '../app/lib/usage.server.ts'
import type { CostSample, UsageSample } from '../app/lib/usage.server.ts'
import { closePool } from '../app/lib/db.server.ts'

// The db workspace is plain ESM with no type declarations and the panel's
// tsconfig does not compile JavaScript. A computed specifier keeps `tsc
// --noEmit` from typing a module it cannot see.
const load = (path: string) => import(new URL(path, import.meta.url).href)

const { freshDatabase, TEST_URL } = (await load('../../db/test-support/helpers.mjs')) as {
  freshDatabase: (schemaName: string) => Promise<TestDatabase>
  TEST_URL: string
}
const { migrate } = (await load('../../db/migrate.mjs')) as {
  migrate: (pool: Pool, dir?: string) => Promise<string[]>
}

type TestDatabase = { pool: Pool; schemaName: string; end: () => Promise<void> }

const SCHEMA = 'usage_layer_test'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

let db: TestDatabase

const realFetch = globalThis.fetch

type Call = { url: string; auth: string | null; body: { query: string; variables: Record<string, unknown> } }

let calls: Call[] = []

function stubFetch(respond: () => Response | Promise<Response>): void {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    })
    return respond()
  }) as typeof fetch
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sample(input: Partial<CostSample> & { estimatedCost: number | null }): CostSample {
  return {
    sampledAt: input.sampledAt ?? new Date(),
    estimatedCost: input.estimatedCost,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
  }
}

/** One row as the hourly sampler would write it on a machine with no bill. */
async function seedLocal(reading: { cpuVcpu: number; memoryGb: number; diskGb: number }): Promise<void> {
  await db.pool.query(
    `INSERT INTO usage_samples (source, cpu_vcpu, memory_gb, disk_gb, estimated_cost)
     VALUES ('local', $1, $2, $3, NULL)`,
    [reading.cpuVcpu, reading.memoryGb, reading.diskGb]
  )
}

/** A period open around `now`, so the projection has a partial cycle to work with. */
async function seedCost(cost: number, elapsedDays: number, remainingDays: number): Promise<void> {
  const now = Date.now()
  await db.pool.query(
    `INSERT INTO usage_samples (source, estimated_cost, period_start, period_end)
     VALUES ('railway', $1, $2::timestamptz, $3::timestamptz)`,
    [
      cost,
      new Date(now - elapsedDays * DAY_MS).toISOString(),
      new Date(now + remainingDays * DAY_MS).toISOString(),
    ]
  )
}

async function countSamples(): Promise<number> {
  const { rows } = await db.pool.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM usage_samples'
  )
  return rows[0].total
}

before(async () => {
  db = await freshDatabase(SCHEMA)
  await migrate(db.pool)

  // db.server builds its own pool from the environment, so the test schema has
  // to reach it through the connection startup parameters rather than a SET.
  process.env.DATABASE_URL = TEST_URL
  process.env.PGOPTIONS = `-c search_path=${SCHEMA},public`
})

beforeEach(async () => {
  globalThis.fetch = realFetch
  delete process.env.RAILWAY_API_TOKEN
  delete process.env.RAILWAY_PROJECT_ID
  delete process.env.PLAN_CEILING_USD
  delete process.env.USAGE_MONITOR
  await db.pool.query('TRUNCATE usage_samples')
})

after(async () => {
  globalThis.fetch = realFetch
  await closePool()
  await db.end()
})

describe('projectCost', () => {
  it('projects the end of the cycle from a partial one', () => {
    const now = new Date('2026-03-11T00:00:00Z')
    const result = projectCost(
      [
        sample({
          sampledAt: now,
          estimatedCost: 2.5,
          periodStart: new Date('2026-03-01T00:00:00Z'),
          periodEnd: new Date('2026-04-01T00:00:00Z'),
        }),
      ],
      now
    )
    // US$ 2.50 over ten days is US$ 0.25 a day, and the month is 31 days long.
    assert.deepEqual(result, { projected: 7.75, perDay: 0.25 })
  })

  it('falls back to the calendar month when the sample carries no period', () => {
    const now = new Date('2026-03-11T00:00:00Z')
    const result = projectCost([sample({ sampledAt: now, estimatedCost: 2.5 })], now)
    assert.deepEqual(result, { projected: 7.75, perDay: 0.25 })
  })

  it('uses the cycle the provider reported over the calendar month', () => {
    const now = new Date('2026-03-15T00:00:00Z')
    const result = projectCost(
      [
        sample({
          sampledAt: now,
          estimatedCost: 2.5,
          // A cycle that starts on the 5th: ten days in, thirty-one days long.
          periodStart: new Date('2026-03-05T00:00:00Z'),
          periodEnd: new Date('2026-04-05T00:00:00Z'),
        }),
      ],
      now
    )
    assert.deepEqual(result, { projected: 7.75, perDay: 0.25 })
  })

  it('withholds the forecast in the first hour of a cycle', () => {
    const now = new Date('2026-03-01T00:30:00Z')
    const result = projectCost(
      [
        sample({
          sampledAt: now,
          estimatedCost: 0.12,
          periodStart: new Date('2026-03-01T00:00:00Z'),
          periodEnd: new Date('2026-04-01T00:00:00Z'),
        }),
      ],
      now
    )
    // Thirty minutes of spend extrapolated over a month reads US$ 172. The
    // money already spent is the honest floor until the rate means something.
    assert.deepEqual(result, { projected: 0.12, perDay: 0 })
  })

  it('ignores a sample from a cycle that has already closed', () => {
    const now = new Date('2026-03-11T00:00:00Z')
    const result = projectCost(
      [
        sample({
          sampledAt: new Date('2026-02-20T00:00:00Z'),
          estimatedCost: 20,
          periodStart: new Date('2026-02-01T00:00:00Z'),
          periodEnd: new Date('2026-03-01T00:00:00Z'),
        }),
      ],
      now
    )
    assert.deepEqual(result, { projected: 0, perDay: 0 }, "last month's bill says nothing about this one")
  })

  it('reads the newest sample that carries a cost', () => {
    const now = new Date('2026-03-11T00:00:00Z')
    const result = projectCost(
      [
        sample({ sampledAt: new Date('2026-03-10T00:00:00Z'), estimatedCost: 2.25 }),
        sample({ sampledAt: new Date('2026-03-11T00:00:00Z'), estimatedCost: 2.5 }),
        // A local sample taken last: it knows the memory, not the money.
        sample({ sampledAt: new Date('2026-03-11T00:00:00Z'), estimatedCost: null }),
      ],
      now
    )
    assert.deepEqual(result, { projected: 7.75, perDay: 0.25 })
  })

  it('returns zeros when nothing has been sampled', () => {
    assert.deepEqual(projectCost([], new Date('2026-03-11T00:00:00Z')), {
      projected: 0,
      perDay: 0,
    })
  })
})

describe('usageStatus', () => {
  it('does not crash on an installation that has never sampled', async () => {
    const status = await usageStatus()

    // 'unknown', not 'ok'. A level is a judgement about a bill, and with no
    // priced sample there is nothing to judge — 'ok' rendered as "comfortably
    // inside the plan", which is a reassurance nobody had measured, shown on
    // every self-hosted install that has no bill at all.
    assert.equal(status.level, 'unknown')
    assert.equal(status.source, null, 'no sample means no source')
    assert.equal(status.projected, 0)
    assert.equal(status.planCeiling, 5)
    assert.ok(status.advice.length > 0, 'silence would read as "everything is fine"')
    assert.ok(
      status.advice.some((line) => /sampleUsage/.test(line)),
      `no advice names the missing sampler:\n${status.advice.join('\n')}`
    )
  })

  it('carries the reading it measured, not only the money it could not compute', async () => {
    // The screen could previously only talk about cost, which is a Railway
    // concept. A Compose install has no bill, so it was shown "$0.00 of $5.00"
    // while the CPU, memory and disk this module samples every hour went
    // nowhere. Exposing them is what lets the page say something true.
    await seedLocal({ cpuVcpu: 0.42, memoryGb: 0.19, diskGb: 3.5 })

    const status = await usageStatus()

    assert.equal(status.source, 'local')
    assert.equal(status.cpuVcpu, 0.42)
    assert.equal(status.memoryGb, 0.19)
    assert.equal(status.diskGb, 3.5)
    assert.ok(status.sampledAt, 'a reading without a timestamp cannot be called stale')

    // And still no verdict about a plan it is not on.
    assert.equal(status.level, 'unknown')
  })

  it('does not tell a self-hosted operator to set Railway variables', async () => {
    // Advice about a product they did not install. INFRA_PROVIDER says which
    // world this installation lives in.
    const before = process.env.INFRA_PROVIDER
    process.env.INFRA_PROVIDER = 'compose'
    try {
      await seedLocal({ cpuVcpu: 0.1, memoryGb: 0.1, diskGb: 1 })
      const status = await usageStatus()
      assert.ok(
        !status.advice.some((line) => /RAILWAY_API_TOKEN/.test(line)),
        `advice mentions Railway on a Compose install:\n${status.advice.join('\n')}`
      )
    } finally {
      if (before === undefined) delete process.env.INFRA_PROVIDER
      else process.env.INFRA_PROVIDER = before
    }
  })

  it('reads the plan ceiling from the environment', async () => {
    process.env.PLAN_CEILING_USD = '20'
    const status = await usageStatus()
    assert.equal(status.planCeiling, 20)
  })

  it('stays quiet while the projection sits well inside the allowance', async () => {
    // US$ 1.00 over ten days of a thirty-day cycle projects to US$ 3.00.
    await seedCost(1, 10, 20)
    const status = await usageStatus()
    assert.equal(status.level, 'ok')
    assert.equal(status.projected, 3)
    assert.deepEqual(status.advice, [], 'nothing to do is a legitimate answer')
  })

  it('warns before the allowance is spent, not after', async () => {
    // Projects to US$ 4.50 against a US$ 5.00 allowance.
    await seedCost(1.5, 10, 20)
    const status = await usageStatus()
    assert.equal(status.level, 'warning')
    assert.equal(status.projected, 4.5)
    assert.ok(status.advice.length > 0)
  })

  it('says what the invoice will be and what to do about it', async () => {
    // A Railway installation: two of the levers below are instructions for
    // Railway's console, and naming a console the operator does not have is
    // worse than saying nothing, so they are gated on this.
    const before = process.env.INFRA_PROVIDER
    process.env.INFRA_PROVIDER = 'railway'
    try {
    // Projects to US$ 6.00 against a US$ 5.00 allowance.
    await seedCost(2, 10, 20)
    const status = await usageStatus()
    assert.equal(status.level, 'over')
    assert.equal(status.projected, 6)

    const advice = status.advice.join('\n')
    assert.ok(/6\.00/.test(advice), `the projected total is missing:\n${advice}`)
    assert.ok(/5\.00/.test(advice), `the allowance is missing:\n${advice}`)
    assert.ok(/retention/i.test(advice), `no retention lever:\n${advice}`)
    assert.ok(/serverless/i.test(advice), `no way to sleep the panel:\n${advice}`)
    assert.ok(/replica/i.test(advice), `no replica lever:\n${advice}`)
    assert.ok(/PLAN_CEILING_USD/.test(advice), `no way to raise the ceiling:\n${advice}`)
    assert.ok(
      !/consider|might want|optimi[sz]/i.test(advice),
      `advice that suggests instead of instructing:\n${advice}`
    )
    } finally {
      if (before === undefined) delete process.env.INFRA_PROVIDER
      else process.env.INFRA_PROVIDER = before
    }
  })

  it('a self-hosted install over its ceiling is not sent to a Railway console', async () => {
    // The disk lever applies anywhere; the console instructions do not.
    const before = process.env.INFRA_PROVIDER
    process.env.INFRA_PROVIDER = 'compose'
    try {
      await seedCost(2, 10, 20)
      const advice = (await usageStatus()).advice.join('\n')
      assert.ok(/retention/i.test(advice), `the disk lever applies anywhere:\n${advice}`)
      assert.ok(!/serverless|Replicas/i.test(advice), `Railway console advice leaked:\n${advice}`)
    } finally {
      if (before === undefined) delete process.env.INFRA_PROVIDER
      else process.env.INFRA_PROVIDER = before
    }
  })

  it('counts the days left in the cycle it is projecting', async () => {
    await seedCost(1, 10, 5)
    const status = await usageStatus()
    assert.equal(status.daysLeft, 5)
  })
})

describe('sampleUsage', () => {
  it('degrades to a local sample when there is no Railway token', async () => {
    stubFetch(() => json({ data: { estimatedUsage: [] } }))

    const taken = await sampleUsage()
    assert.ok(taken, 'a missing token is not a reason to record nothing')
    assert.equal(taken.source, 'local')
    assert.equal(calls.length, 0, 'no token means no call to make')
    assert.ok(taken.memoryGb !== null && taken.memoryGb > 0, 'the process knows its own memory')
    assert.equal(taken.estimatedCost, null, 'a local sample has no bill to read')
    assert.equal(await countSamples(), 1)
  })

  it('records what the Railway API reports', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token'
    process.env.RAILWAY_PROJECT_ID = 'project-1'
    stubFetch(() =>
      json({
        data: {
          estimatedUsage: [
            { measurement: 'CPU_USAGE', estimatedValue: 1.5 },
            { measurement: 'MEMORY_USAGE_GB', estimatedValue: 0.75 },
            { measurement: 'NETWORK_TX_GB', estimatedValue: 2.25 },
            { measurement: 'DISK_USAGE_GB', estimatedValue: 1.1 },
            { measurement: 'ESTIMATED_USAGE_USD', estimatedValue: 6.4 },
          ],
        },
      })
    )

    const taken = await sampleUsage()
    assert.ok(taken)
    assert.equal(taken.source, 'railway')
    assert.equal(taken.cpuVcpu, 1.5)
    assert.equal(taken.memoryGb, 0.75)
    assert.equal(taken.egressGb, 2.25)
    assert.equal(taken.diskGb, 1.1)
    assert.equal(taken.estimatedCost, 6.4)
    assert.ok(taken.periodStart && taken.periodEnd, 'a cost without a cycle cannot be projected')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://backboard.railway.com/graphql/v2')
    assert.equal(calls[0].auth, 'Bearer test-token')
    assert.equal(calls[0].body.variables.projectId, 'project-1')
  })

  it('degrades to a local sample when the API answers with errors', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token'
    process.env.RAILWAY_PROJECT_ID = 'project-1'
    stubFetch(() => json({ errors: [{ message: 'Not Authorized' }] }, 200))

    const taken = await sampleUsage()
    assert.ok(taken, 'a monitor that throws on a bad token takes the whole job down with it')
    assert.equal(taken.source, 'local')
    assert.equal(await countSamples(), 1)
  })

  it('degrades to a local sample when the schema is not the one we expect', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token'
    process.env.RAILWAY_PROJECT_ID = 'project-1'
    stubFetch(() =>
      json({ data: { estimatedUsage: [{ measurement: 'SOMETHING_NEW', estimatedValue: 3 }] } })
    )

    const taken = await sampleUsage()
    assert.ok(taken)
    assert.equal(taken.source, 'local', 'a payload we cannot read is not a Railway sample')
  })

  it('degrades to a local sample when the request itself fails', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token'
    process.env.RAILWAY_PROJECT_ID = 'project-1'
    stubFetch(() => {
      throw new Error('connect ECONNREFUSED')
    })

    const taken = await sampleUsage()
    assert.ok(taken)
    assert.equal(taken.source, 'local')
  })

  it('records nothing when the monitor is switched off', async () => {
    process.env.USAGE_MONITOR = 'off'
    const taken: UsageSample | null = await sampleUsage()
    assert.equal(taken, null)
    assert.equal(await countSamples(), 0, 'a flat-rate VPS should not grow a table forever')
  })

  it('feeds the status it just wrote', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token'
    process.env.RAILWAY_PROJECT_ID = 'project-1'
    stubFetch(() =>
      json({
        data: { estimatedUsage: [{ measurement: 'ESTIMATED_USAGE_USD', estimatedValue: 40 }] },
      })
    )

    await sampleUsage()
    const status = await usageStatus()
    // Sampled inside the current calendar month, so a US$ 40 spend that is
    // already eight times the allowance can only project over it.
    assert.equal(status.level, 'over')
    assert.ok(status.projected >= 40)
  })

  it('tells the operator when the sampler fell back without being asked to', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token'
    process.env.RAILWAY_PROJECT_ID = 'project-1'
    stubFetch(() => json({ errors: [{ message: 'Not Authorized' }] }, 200))

    await sampleUsage()
    const status = await usageStatus()
    assert.ok(
      status.advice.some((line) => /RAILWAY_API_TOKEN/.test(line)),
      `a blind monitor must say so:\n${status.advice.join('\n')}`
    )
  })
})

describe('projectCost boundaries', () => {
  it('treats a cost recorded moments ago as spend, not as a rate', () => {
    const now = new Date()
    const result = projectCost(
      [
        sample({
          sampledAt: new Date(now.getTime() - MINUTE_MS),
          estimatedCost: 0.4,
          periodStart: new Date(now.getTime() - 2 * MINUTE_MS),
          periodEnd: new Date(now.getTime() + 30 * DAY_MS),
        }),
      ],
      now
    )
    assert.deepEqual(result, { projected: 0.4, perDay: 0 })
  })
})
