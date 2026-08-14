import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { migrate } from '../../db/migrate.mjs'
import { freshDatabase } from '../../db/test-support/helpers.mjs'
import { createCollector } from '../src/collect.mjs'
import { createGeoLookup, ensureDatabase, startGeoRefresh } from '../src/geo.mjs'

// The databases in these tests are written here, byte by byte, because the real
// ones cannot be committed: MaxMind's licence forbids redistributing GeoLite2
// inside a public repository, which is the whole reason every installation
// downloads its own. A fixture written by hand is also the only way to assert
// what a parser does with a file nobody could otherwise produce — a truncated
// one, a corrupt one, a 24-bit tree.
//
// Set GEO_TEST_DB to a real GeoLite2-City.mmdb to run the last test in the file
// against MaxMind's own bytes.

// ---------------------------------------------------------------------------
// Writing a MaxMind DB
// ---------------------------------------------------------------------------

class U16 {
  constructor(value) {
    this.value = value
  }
}

class U64 {
  constructor(value) {
    this.value = value
  }
}

const NUL = 0
const MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com')])

function control(type, size) {
  const bytes = [type < 8 ? (type << 5) | sizeBits(size) : sizeBits(size)]
  if (type >= 8) bytes.push(type - 7)
  if (size >= 29 && size < 285) bytes.push(size - 29)
  else if (size >= 285) bytes.push((size - 285) >> 8, (size - 285) & 0xff)
  return Buffer.from(bytes)
}

function sizeBits(size) {
  if (size < 29) return size
  if (size < 285) return 29
  if (size < 65821) return 30
  throw new Error('fixture value is larger than the writer supports')
}

function unsigned(type, value) {
  const bytes = []
  let rest = value
  while (rest > 0) {
    bytes.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return Buffer.concat([control(type, bytes.length), Buffer.from(bytes)])
}

function encode(value) {
  if (value instanceof U16) return unsigned(5, value.value)
  if (value instanceof U64) return unsigned(9, value.value)
  if (typeof value === 'number') return unsigned(6, value)
  if (typeof value === 'string') {
    const body = Buffer.from(value, 'utf8')
    return Buffer.concat([control(2, body.length), body])
  }
  if (Array.isArray(value)) {
    return Buffer.concat([control(11, value.length), ...value.map(encode)])
  }
  const keys = Object.keys(value)
  return Buffer.concat([control(7, keys.length), ...keys.flatMap((key) => [encode(key), encode(value[key])])])
}

function addressBytes(address) {
  if (!address.includes(':')) return Buffer.from(address.split('.').map(Number))
  const halves = address.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups = [...head]
  if (halves.length === 2) for (let i = head.length + tail.length; i < 8; i += 1) groups.push('0')
  groups.push(...tail)
  const bytes = Buffer.alloc(16)
  groups.forEach((group, i) => bytes.writeUInt16BE(Number.parseInt(group, 16), i * 2))
  return bytes
}

// An IPv4 network inside an IPv6 database lives where a real GeoLite2 file
// keeps it: under ::ffff:0:0/96.
function networkBits(network, ipVersion) {
  const [address, size] = network.split('/')
  let bytes = addressBytes(address)
  let prefix = Number(size)
  if (bytes.length === 4 && ipVersion === 6) {
    bytes = Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), bytes])
    prefix += 96
  }
  const bits = []
  for (let i = 0; i < prefix; i += 1) bits.push((bytes[i >> 3] >> (7 - (i & 7))) & 1)
  return bits
}

function writeRecord(tree, node, side, value, recordSize) {
  const at = node * ((recordSize * 2) / 8)
  if (recordSize === 32) {
    tree.writeUInt32BE(value, at + side * 4)
    return
  }
  if (recordSize === 24) {
    tree.writeUIntBE(value, at + side * 3, 3)
    return
  }
  // 28-bit records share the middle byte between the two sides.
  if (side === 0) {
    tree.writeUIntBE(value & 0xffffff, at, 3)
    tree[at + 3] |= ((value >> 24) & 0x0f) << 4
  } else {
    tree.writeUIntBE(value & 0xffffff, at + 4, 3)
    tree[at + 3] |= (value >> 24) & 0x0f
  }
}

function buildDatabase({
  databaseType = 'GeoLite2-City',
  ipVersion = 6,
  recordSize = 28,
  buildEpoch = 1_755_000_000,
  networks,
}) {
  const chunks = []
  let dataLength = 0
  const nodes = [[null, null]]

  for (const { network, data } of networks) {
    const encoded = encode(data)
    const dataOffset = dataLength
    chunks.push(encoded)
    dataLength += encoded.length

    const bits = networkBits(network, ipVersion)
    let cursor = 0
    for (let i = 0; i < bits.length - 1; i += 1) {
      let slot = nodes[cursor][bits[i]]
      if (!slot) {
        nodes.push([null, null])
        slot = { node: nodes.length - 1 }
        nodes[cursor][bits[i]] = slot
      }
      assert.ok(slot.node !== undefined, 'fixture networks must not overlap')
      cursor = slot.node
    }
    nodes[cursor][bits[bits.length - 1]] = { dataOffset }
  }

  const nodeCount = nodes.length
  const tree = Buffer.alloc(nodeCount * ((recordSize * 2) / 8))
  for (let node = 0; node < nodeCount; node += 1) {
    for (const side of [0, 1]) {
      const slot = nodes[node][side]
      const value = !slot
        ? nodeCount
        : slot.node !== undefined
          ? slot.node
          : nodeCount + 16 + slot.dataOffset
      writeRecord(tree, node, side, value, recordSize)
    }
  }

  const metadata = encode({
    node_count: nodeCount,
    record_size: new U16(recordSize),
    ip_version: new U16(ipVersion),
    database_type: databaseType,
    languages: ['en'],
    binary_format_major_version: new U16(2),
    binary_format_minor_version: new U16(0),
    build_epoch: new U64(buildEpoch),
    description: { en: 'linkyard test fixture' },
  })

  return Buffer.concat([tree, Buffer.alloc(16), ...chunks, MARKER, metadata])
}

// ---------------------------------------------------------------------------
// Writing what MaxMind serves: one .mmdb inside a gzipped tar
// ---------------------------------------------------------------------------

function tarball(name, body) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644', 100, 7)
  header.write('0000000', 108, 7)
  header.write('0000000', 116, 7)
  header.write(body.length.toString(8).padStart(11, '0'), 124, 11)
  header.write('00000000000', 136, 11)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar', 257, 5)
  header.write('00', 263, 2)

  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6)
  header[154] = NUL
  header[155] = 0x20

  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)])
}

function archiveOf(database, editionId = 'GeoLite2-City') {
  return gzipSync(tarball(`${editionId}_20260812/${editionId}.mmdb`, database))
}

function respond(body) {
  return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => body }
}

/** A fetch that serves one archive and, when asked, its checksum. */
function serve({ archive, checksum = createHash('sha256').update(archive).digest('hex') }) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('.sha256')) return respond(Buffer.from(`${checksum}  GeoLite2-City.tar.gz\n`))
    return respond(archive)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

const CITY_NETWORKS = [
  {
    network: '1.2.3.0/24',
    data: {
      country: { iso_code: 'gb', names: { en: 'United Kingdom' } },
      subdivisions: [{ iso_code: 'ENG', names: { en: 'England' } }],
      city: { names: { en: 'London' } },
    },
  },
  {
    network: '8.8.8.0/24',
    data: {
      country: { iso_code: 'US' },
      subdivisions: [{ names: { en: 'California' } }],
      city: { names: { en: 'Mountain View' } },
    },
  },
  {
    network: '2606:4700::/32',
    data: {
      country: { iso_code: 'US' },
      subdivisions: [{ names: { en: 'Texas' } }],
      city: { names: { en: 'Austin' } },
    },
  },
  {
    // No country of its own, only a registered one — the shape a database uses
    // for an address that belongs to a network registered elsewhere.
    network: '5.6.7.0/24',
    data: { registered_country: { iso_code: 'DE' } },
  },
]

const ASN_NETWORKS = [
  { network: '8.8.8.0/24', data: { autonomous_system_number: 15169, autonomous_system_organization: 'GOOGLE' } },
  {
    // Past the ceiling of click_events.asn, which is a signed 32-bit integer.
    network: '1.2.3.0/24',
    data: { autonomous_system_number: 4_200_000_001, autonomous_system_organization: 'RESERVED' },
  },
]

const cityDatabase = (recordSize = 28) =>
  buildDatabase({ databaseType: 'GeoLite2-City', recordSize, networks: CITY_NETWORKS })
const asnDatabase = () => buildDatabase({ databaseType: 'GeoLite2-ASN', networks: ASN_NETWORKS })

async function directoryWith(files) {
  const directory = await mkdtemp(join(tmpdir(), 'linkyard-geo-test-'))
  for (const [name, body] of Object.entries(files)) await writeFile(join(directory, name), body)
  return directory
}

async function fileWith(name, body) {
  const directory = await directoryWith({ [name]: body })
  return join(directory, name)
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

for (const recordSize of [24, 28, 32]) {
  test(`a known address resolves to its country, region and city (${recordSize}-bit records)`, async () => {
    const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase(recordSize)))
    try {
      assert.deepEqual(geo.lookup('8.8.8.8'), {
        country: 'US',
        region: 'California',
        city: 'Mountain View',
        asn: null,
      })
    } finally {
      geo.close()
    }
  })
}

test('a country code is normalised, and a registered country stands in for a missing one', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  try {
    assert.equal(geo.lookup('1.2.3.4').country, 'GB')
    assert.deepEqual(geo.lookup('5.6.7.8'), { country: 'DE', region: null, city: null, asn: null })
  } finally {
    geo.close()
  }
})

test('an IPv6 address resolves', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  try {
    assert.deepEqual(geo.lookup('2606:4700:1234::5'), {
      country: 'US',
      region: 'Texas',
      city: 'Austin',
      asn: null,
    })
  } finally {
    geo.close()
  }
})

// A dual-stack listener reports every IPv4 client in the v4-mapped form. If the
// two forms disagreed, the same visitor would be placed in two different
// countries depending on which socket answered.
test('a v4-mapped IPv6 address resolves as its IPv4 form', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  try {
    assert.deepEqual(geo.lookup('::ffff:8.8.8.8'), geo.lookup('8.8.8.8'))
    assert.deepEqual(geo.lookup('::ffff:0808:0808'), geo.lookup('8.8.8.8'))
    assert.equal(geo.lookup('::ffff:8.8.8.8').city, 'Mountain View')
  } finally {
    geo.close()
  }
})

test('two databases answer together, each contributing what it knows', async () => {
  const directory = await directoryWith({
    'GeoLite2-City.mmdb': cityDatabase(),
    'GeoLite2-ASN.mmdb': asnDatabase(),
  })
  const geo = createGeoLookup([join(directory, 'GeoLite2-City.mmdb'), join(directory, 'GeoLite2-ASN.mmdb')])
  try {
    assert.deepEqual(geo.lookup('8.8.8.8'), {
      country: 'US',
      region: 'California',
      city: 'Mountain View',
      asn: 15169,
    })
  } finally {
    geo.close()
  }
})

// The column is a signed 32-bit integer. Handing Postgres a larger number does
// not lose one click, it aborts the whole batch that click travelled in.
test('an autonomous system number past the column ceiling is dropped, not recorded', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-ASN.mmdb', asnDatabase()))
  try {
    assert.equal(geo.lookup('8.8.8.8').asn, 15169)
    assert.equal(geo.lookup('1.2.3.4'), null)
  } finally {
    geo.close()
  }
})

test('a private address is never placed', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  try {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.4.4',
      '192.168.1.1',
      '169.254.10.10',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '2001:db8::1',
    ]) {
      assert.equal(geo.lookup(address), null, `${address} should not resolve to a place`)
    }
  } finally {
    geo.close()
  }
})

test('an address the database has never heard of returns null', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  try {
    assert.equal(geo.lookup('9.9.9.9'), null)
    assert.equal(geo.lookup('2001:4860::1'), null)
  } finally {
    geo.close()
  }
})

test('junk in place of an address returns null instead of throwing', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  try {
    for (const value of ['', '   ', 'not-an-ip', '8.8.8', '999.1.1.1', 'localhost', null, undefined, 42, {}]) {
      assert.equal(geo.lookup(value), null)
    }
  } finally {
    geo.close()
  }
})

// Every failure of the database has to cost four columns and nothing else. A
// throw here reaches the collector, and the collector runs on the click.
test('a missing database answers null instead of throwing', () => {
  const geo = createGeoLookup('/var/empty/linkyard/does-not-exist.mmdb')
  assert.equal(geo.lookup('8.8.8.8'), null)
  geo.close()
})

test('a corrupt database answers null instead of throwing', async () => {
  const truncated = cityDatabase().subarray(0, 40)
  const noise = Buffer.alloc(4096, 0x5a)
  const headless = cityDatabase().subarray(0, cityDatabase().length - 20)

  for (const [name, bytes] of [
    ['truncated', truncated],
    ['noise', noise],
    ['metadata cut off', headless],
    ['empty', Buffer.alloc(0)],
  ]) {
    const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', bytes))
    assert.equal(geo.lookup('8.8.8.8'), null, `${name} should answer null`)
    geo.close()
  }
})

// A file whose metadata parses but whose tree was cut off is the shape a
// half-written download leaves behind. It must not be read as a database.
test('a database whose tree is shorter than its metadata claims is refused', async () => {
  const full = cityDatabase()
  const metadataStart = full.lastIndexOf(MARKER)
  const beheaded = Buffer.concat([full.subarray(0, 8), full.subarray(metadataStart)])
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', beheaded))
  assert.equal(geo.lookup('8.8.8.8'), null)
  geo.close()
})

test('close stops the lookup answering', async () => {
  const geo = createGeoLookup(await fileWith('GeoLite2-City.mmdb', cityDatabase()))
  assert.ok(geo.lookup('8.8.8.8'))
  geo.close()
  assert.equal(geo.lookup('8.8.8.8'), null)
  geo.close()
})

// ---------------------------------------------------------------------------
// Keeping the database on disk
// ---------------------------------------------------------------------------

const CREDENTIALS = { accountId: '123456', licenseKey: 'test-licence-key' }

test('no credentials and no file means no database, not an error', async () => {
  const directory = await directoryWith({})
  const result = await ensureDatabase({
    directory,
    accountId: undefined,
    licenseKey: undefined,
    fetchImpl: () => assert.fail('must not reach the network without credentials'),
  })
  assert.equal(result, null)
})

test('a file already on disk is served without asking MaxMind for it', async () => {
  const directory = await directoryWith({ 'GeoLite2-City.mmdb': cityDatabase() })
  const result = await ensureDatabase({
    ...CREDENTIALS,
    directory,
    fetchImpl: () => assert.fail('a fresh database must not be downloaded again'),
  })
  assert.equal(result.path, join(directory, 'GeoLite2-City.mmdb'))
  assert.equal(result.builtAt.getTime(), 1_755_000_000 * 1000)
})

test('a stale file is replaced, verified against its checksum, and swapped in one rename', async () => {
  const directory = await directoryWith({ 'GeoLite2-City.mmdb': cityDatabase() })
  const target = join(directory, 'GeoLite2-City.mmdb')
  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await utimes(target, stale, stale)

  const fresh = buildDatabase({ recordSize: 28, buildEpoch: 1_760_000_000, networks: CITY_NETWORKS })
  const fetchImpl = serve({ archive: archiveOf(fresh) })

  const result = await ensureDatabase({ ...CREDENTIALS, directory, fetchImpl })

  assert.equal(result.path, target)
  assert.equal(result.builtAt.getTime(), 1_760_000_000 * 1000)
  assert.deepEqual(await readFile(target), fresh)
  assert.deepEqual(await readdir(directory), ['GeoLite2-City.mmdb'])
  assert.equal(fetchImpl.calls.length, 2)
  assert.ok(fetchImpl.calls[0].endsWith('/GeoLite2-City/download?suffix=tar.gz'))
})

// The licence key belongs in a header. A URL is the one part of a request that
// ends up in proxy logs and error messages without anyone deciding it should.
test('credentials travel in the Authorization header, never in the URL', async () => {
  const directory = await directoryWith({})
  const seen = []
  await ensureDatabase({
    ...CREDENTIALS,
    directory,
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization })
      return respond(archiveOf(cityDatabase()))
    },
  })
  for (const call of seen) {
    assert.ok(!call.url.includes('test-licence-key'), 'the licence key must not appear in the URL')
    assert.ok(!call.url.includes('123456'), 'the account id must not appear in the URL')
    assert.equal(
      call.authorization,
      `Basic ${Buffer.from('123456:test-licence-key').toString('base64')}`
    )
  }
})

for (const [name, broken] of [
  ['a refused download', { fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers() }) }],
  [
    'a download that never arrives',
    { fetchImpl: async () => { throw new Error('socket hang up') } },
  ],
  [
    'an archive with nothing in it',
    { fetchImpl: async () => respond(gzipSync(Buffer.alloc(1024))) },
  ],
  [
    'an archive holding a corrupt database',
    { fetchImpl: async () => respond(archiveOf(Buffer.alloc(9000, 0x17))) },
  ],
  [
    'an archive that is not gzip at all',
    { fetchImpl: async () => respond(Buffer.from('<html>not your database</html>')) },
  ],
]) {
  test(`${name} leaves the working database exactly where it was`, async () => {
    const original = cityDatabase()
    const directory = await directoryWith({ 'GeoLite2-City.mmdb': original })
    const target = join(directory, 'GeoLite2-City.mmdb')
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await utimes(target, stale, stale)

    const result = await ensureDatabase({ ...CREDENTIALS, directory, ...broken })

    assert.equal(result.path, target)
    assert.equal(result.builtAt.getTime(), 1_755_000_000 * 1000)
    assert.deepEqual(await readFile(target), original)
    // Nothing half-written survives: a reader that opened this directory a
    // moment later would find one file, and it would be the good one.
    assert.deepEqual(await readdir(directory), ['GeoLite2-City.mmdb'])
  })
}

test('an archive that disagrees with its published checksum is refused', async () => {
  const original = cityDatabase()
  const directory = await directoryWith({ 'GeoLite2-City.mmdb': original })
  const target = join(directory, 'GeoLite2-City.mmdb')
  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await utimes(target, stale, stale)

  const fresh = buildDatabase({ buildEpoch: 1_760_000_000, networks: CITY_NETWORKS })
  const fetchImpl = serve({ archive: archiveOf(fresh), checksum: 'a'.repeat(64) })

  const result = await ensureDatabase({ ...CREDENTIALS, directory, fetchImpl })

  assert.equal(result.builtAt.getTime(), 1_755_000_000 * 1000)
  assert.deepEqual(await readFile(target), original)
  assert.deepEqual(await readdir(directory), ['GeoLite2-City.mmdb'])
})

test('a checksum that cannot be fetched does not stop a good download', async () => {
  const directory = await directoryWith({})
  const fetchImpl = async (url) => {
    if (url.endsWith('.sha256')) throw new Error('checksum service is down')
    return respond(archiveOf(cityDatabase()))
  }
  const result = await ensureDatabase({ ...CREDENTIALS, directory, fetchImpl })
  assert.equal(result.path, join(directory, 'GeoLite2-City.mmdb'))
})

test('nothing on disk and a failed download means no database at all', async () => {
  const directory = await directoryWith({})
  const result = await ensureDatabase({
    ...CREDENTIALS,
    directory,
    fetchImpl: async () => {
      throw new Error('no route to host')
    },
  })
  assert.equal(result, null)
  assert.deepEqual(await readdir(directory), [])
})

// ---------------------------------------------------------------------------
// The refresh
// ---------------------------------------------------------------------------

test('the refresh opens the databases it finds and hands over one lookup', async () => {
  const directory = await directoryWith({
    'GeoLite2-City.mmdb': cityDatabase(),
    'GeoLite2-ASN.mmdb': asnDatabase(),
  })

  let handed = null
  const stop = startGeoRefresh({
    editions: ['GeoLite2-City', 'GeoLite2-ASN'],
    ...CREDENTIALS,
    directory,
    fetchImpl: () => assert.fail('fresh databases must not be downloaded'),
    onReady: (lookup) => {
      handed = lookup
    },
  })

  try {
    await stop.started
    assert.deepEqual(handed.lookup('8.8.8.8'), {
      country: 'US',
      region: 'California',
      city: 'Mountain View',
      asn: 15169,
    })
  } finally {
    stop()
  }

  assert.equal(handed.lookup('8.8.8.8'), null, 'stopping closes the lookup it handed over')
})

test('the refresh with nothing to load hands over nothing and stops cleanly', async () => {
  const directory = await directoryWith({})
  let handed = null
  const stop = startGeoRefresh({
    editions: ['GeoLite2-City'],
    ...CREDENTIALS,
    directory,
    fetchImpl: async () => {
      throw new Error('no route to host')
    },
    onReady: (lookup) => {
      handed = lookup
    },
  })
  await stop.started
  stop()
  assert.equal(handed, null)
})

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for the retry')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// MaxMind being unreachable for the minute a service happens to boot must not
// cost the country of every click for the following week.
test('a first attempt that fails is tried again rather than left until next week', async () => {
  const directory = await directoryWith({})
  let attempts = 0
  let handed = null

  const stop = startGeoRefresh({
    editions: ['GeoLite2-City'],
    ...CREDENTIALS,
    directory,
    retryMs: 5,
    fetchImpl: async (url) => {
      if (url.endsWith('.sha256')) throw new Error('no checksum here')
      attempts += 1
      if (attempts === 1) throw new Error('no route to host')
      return respond(archiveOf(cityDatabase()))
    },
    onReady: (lookup) => {
      handed = lookup
    },
  })

  try {
    await stop.started
    assert.equal(handed, null, 'the first round found nothing')
    await waitFor(() => handed !== null)
    assert.equal(handed.lookup('8.8.8.8').country, 'US')
  } finally {
    stop()
  }
})

// ---------------------------------------------------------------------------
// The click path
// ---------------------------------------------------------------------------

test('the collector places a click and keeps the address out of the database', async () => {
  const directory = await directoryWith({
    'GeoLite2-City.mmdb': cityDatabase(),
    'GeoLite2-ASN.mmdb': asnDatabase(),
  })
  const geo = createGeoLookup([join(directory, 'GeoLite2-City.mmdb'), join(directory, 'GeoLite2-ASN.mmdb')])
  const db = await freshDatabase('edge_geo_test')

  try {
    await migrate(db.pool)
    const collector = createCollector({ pool: db.pool, flushMs: 5, geo })

    collector.record({ linkId: randomUUID(), ip: '8.8.8.8', ipHash: Buffer.alloc(32, 1), device: 'desktop' })
    // An address no database can place still records a click, with the four
    // columns empty and nothing else missing.
    collector.record({ linkId: randomUUID(), ip: '10.0.0.9', ipHash: Buffer.alloc(32, 2), device: 'mobile' })
    await collector.stop()

    const { rows } = await db.pool.query(
      'SELECT country, region, city, asn, device FROM click_events ORDER BY device'
    )
    assert.deepEqual(rows, [
      { country: 'US', region: 'California', city: 'Mountain View', asn: 15169, device: 'desktop' },
      { country: null, region: null, city: null, asn: null, device: 'mobile' },
    ])

    // The address was read and dropped. What is stored is the HMAC the caller
    // supplied, and nothing in the row is the thing itself.
    const everything = await db.pool.query('SELECT * FROM click_events')
    for (const row of everything.rows) {
      for (const value of Object.values(row)) {
        assert.notEqual(String(value), '8.8.8.8')
      }
    }
  } finally {
    geo.close()
    await db.end()
  }
})

// ---------------------------------------------------------------------------
// MaxMind's own bytes, when an operator has a copy to point at
// ---------------------------------------------------------------------------

test('a real GeoLite2 database resolves a public address', { skip: !process.env.GEO_TEST_DB }, () => {
  const geo = createGeoLookup(process.env.GEO_TEST_DB.split(','))
  try {
    const place = geo.lookup('8.8.8.8')
    assert.ok(place, 'expected 8.8.8.8 to resolve in a real database')
    assert.equal(place.country, 'US')
    assert.deepEqual(geo.lookup('::ffff:8.8.8.8'), place)
    assert.equal(geo.lookup('10.0.0.1'), null)
  } finally {
    geo.close()
  }
})
