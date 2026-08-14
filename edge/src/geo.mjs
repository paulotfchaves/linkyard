// Where a click came from, read from a MaxMind GeoLite2 database this process
// holds in memory.
//
// Three rules shaped everything below.
//
// It never touches the visitor's path. The lookup is called from the collector,
// which runs with the response already on the wire. A geo lookup that delays a
// redirect trades the product's one non-negotiable promise for a column in a
// report.
//
// It is a soft dependency in every failure mode. No licence key, a refused
// download, a truncated archive, a corrupt file, an address nobody can place —
// each of them means the four columns stay null and the click is still
// recorded. Nothing here may throw into the collector, and nothing here may
// stop the edge from starting.
//
// It carries no runtime dependency. The MMDB format is a binary search tree
// over the address followed by a data section, and reading it takes the two
// hundred lines below. The alternative was a package on the edge, which is the
// one process in this product that earns the right to refuse them.
//
// And one rule that is not about geography: an address never reaches a log
// line. It is read, turned into a place, and dropped.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open as openFile, rename, stat, unlink } from 'node:fs/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

const gunzip = promisify(gunzipCallback)

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_EDITIONS = ['GeoLite2-City', 'GeoLite2-ASN']
const DOWNLOAD_ORIGIN = 'https://download.maxmind.com'
const DOWNLOAD_TIMEOUT_MS = 120_000
// GeoLite2-City is around 60 MB compressed today. The ceiling exists so a
// broken or hostile response cannot be read into memory until the edge dies.
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

// ---------------------------------------------------------------------------
// The MaxMind DB format
// ---------------------------------------------------------------------------

// The metadata map sits at the end of the file, introduced by this marker. The
// format has no header, so the only way in is to search backwards for it.
const METADATA_MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com')])
// The marker is within a few kilobytes of the end in every real database; a
// quarter of a megabyte means the freshness check reads a tail instead of 60 MB.
const METADATA_SCAN_BYTES = 256 * 1024
// Sixteen zero bytes separate the search tree from the data section, and every
// data pointer in the tree is expressed relative to a point 16 bytes before the
// data section starts.
const DATA_SEPARATOR_BYTES = 16

const TYPE_POINTER = 1
const TYPE_STRING = 2
const TYPE_DOUBLE = 3
const TYPE_BYTES = 4
const TYPE_UINT16 = 5
const TYPE_UINT32 = 6
const TYPE_MAP = 7
const TYPE_INT32 = 8
const TYPE_UINT64 = 9
const TYPE_UINT128 = 10
const TYPE_ARRAY = 11
const TYPE_CACHE = 12
const TYPE_END = 13
const TYPE_BOOLEAN = 14
const TYPE_FLOAT = 15

// A pointer whose target is another pointer is not something a real database
// contains, but a corrupt one can, and a cycle would hang the process that is
// answering redirects.
const MAX_POINTER_DEPTH = 8

function readUnsigned(buf, offset, size) {
  if (size === 0) return 0
  if (size <= 6) return buf.readUIntBE(offset, size)
  let value = 0n
  for (let i = 0; i < size; i += 1) value = (value << 8n) | BigInt(buf[offset + i])
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER
}

/**
 * One value from the data section.
 *
 * `base` is where pointers are measured from: the start of the data section
 * when decoding a record, the start of the metadata section when decoding
 * metadata. The two sections use the same encoding and different origins.
 */
function decodeValue(buf, offset, base, depth = 0) {
  if (offset < 0 || offset >= buf.length) throw new RangeError('mmdb: read past the end of the file')

  const control = buf[offset]
  offset += 1
  let type = control >> 5
  if (type === 0) {
    type = buf[offset] + 7
    offset += 1
  }

  if (type === TYPE_POINTER) {
    if (depth >= MAX_POINTER_DEPTH) throw new RangeError('mmdb: pointer chain too deep')
    const width = (control >> 3) & 0x03
    let pointer
    if (width === 0) {
      pointer = ((control & 0x07) << 8) | buf[offset]
      offset += 1
    } else if (width === 1) {
      pointer = (((control & 0x07) << 16) | buf.readUIntBE(offset, 2)) + 2048
      offset += 2
    } else if (width === 2) {
      pointer = (((control & 0x07) << 24) | buf.readUIntBE(offset, 3)) + 526336
      offset += 3
    } else {
      pointer = buf.readUInt32BE(offset)
      offset += 4
    }
    return { value: decodeValue(buf, base + pointer, base, depth + 1).value, offset }
  }

  let size = control & 0x1f
  if (size === 29) {
    size = 29 + buf[offset]
    offset += 1
  } else if (size === 30) {
    size = 285 + buf.readUInt16BE(offset)
    offset += 2
  } else if (size === 31) {
    size = 65821 + buf.readUIntBE(offset, 3)
    offset += 3
  }

  // For every type but the four below, `size` is a byte count, and a value that
  // claims more bytes than the file holds means the file is truncated. Without
  // this check Buffer.toString would quietly clamp to the end and hand back
  // half a string — a corrupt database passing itself off as a good one, which
  // is the one outcome a reader of downloaded files must not allow.
  const counted = type === TYPE_MAP || type === TYPE_ARRAY || type === TYPE_BOOLEAN || type === TYPE_CACHE
  if (!counted && offset + size > buf.length) {
    throw new RangeError('mmdb: a value runs past the end of the file')
  }

  switch (type) {
    case TYPE_STRING:
      return { value: buf.toString('utf8', offset, offset + size), offset: offset + size }
    case TYPE_DOUBLE:
      return { value: size === 8 ? buf.readDoubleBE(offset) : 0, offset: offset + size }
    case TYPE_FLOAT:
      return { value: size === 4 ? buf.readFloatBE(offset) : 0, offset: offset + size }
    case TYPE_BYTES:
      return { value: Buffer.from(buf.subarray(offset, offset + size)), offset: offset + size }
    case TYPE_UINT16:
    case TYPE_UINT32:
    case TYPE_UINT64:
    case TYPE_UINT128:
      return { value: readUnsigned(buf, offset, size), offset: offset + size }
    case TYPE_INT32:
      return { value: size === 0 ? 0 : buf.readIntBE(offset, size), offset: offset + size }
    case TYPE_BOOLEAN:
      return { value: size === 1, offset }
    case TYPE_MAP: {
      const map = {}
      let cursor = offset
      for (let i = 0; i < size; i += 1) {
        const key = decodeValue(buf, cursor, base, depth)
        const value = decodeValue(buf, key.offset, base, depth)
        map[String(key.value)] = value.value
        cursor = value.offset
      }
      return { value: map, offset: cursor }
    }
    case TYPE_ARRAY: {
      const list = []
      let cursor = offset
      for (let i = 0; i < size; i += 1) {
        const item = decodeValue(buf, cursor, base, depth)
        list.push(item.value)
        cursor = item.offset
      }
      return { value: list, offset: cursor }
    }
    case TYPE_CACHE:
    case TYPE_END:
      // Both are structural markers a reader walks past; neither is ever the
      // value of a record.
      return { value: null, offset }
    default:
      throw new RangeError(`mmdb: unknown data type ${type}`)
  }
}

function readMetadata(tail) {
  const marker = tail.lastIndexOf(METADATA_MARKER)
  if (marker === -1) throw new Error('mmdb: metadata marker not found')
  const base = marker + METADATA_MARKER.length
  const metadata = decodeValue(tail, base, base).value
  if (!metadata || typeof metadata !== 'object') throw new Error('mmdb: metadata is not a map')

  const nodeCount = metadata.node_count
  const recordSize = metadata.record_size
  const ipVersion = metadata.ip_version
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) throw new Error('mmdb: node_count is not usable')
  if (recordSize !== 24 && recordSize !== 28 && recordSize !== 32) {
    throw new Error(`mmdb: unsupported record size ${recordSize}`)
  }
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error(`mmdb: unsupported ip version ${ipVersion}`)
  return metadata
}

/**
 * A database, opened over a buffer holding the whole file.
 *
 * The whole file, because the alternative is a positional read per tree node —
 * up to 128 of them per lookup, each a synchronous syscall on the event loop
 * this process uses to answer redirects. GeoLite2-City costs about 60 MB of
 * resident memory for that; GeoLite2-Country costs a tenth of it, which is why
 * the edition is an operator's choice and not a constant.
 */
function openDatabase(buf) {
  const metadata = readMetadata(buf)
  const nodeCount = metadata.node_count
  const recordSize = metadata.record_size
  const nodeBytes = (recordSize * 2) / 8
  const treeBytes = nodeCount * nodeBytes
  const dataStart = treeBytes + DATA_SEPARATOR_BYTES
  if (dataStart >= buf.length) throw new Error('mmdb: file is shorter than its own search tree')

  function record(node, bit) {
    const at = node * nodeBytes
    if (recordSize === 32) return buf.readUInt32BE(at + bit * 4)
    if (recordSize === 24) return buf.readUIntBE(at + bit * 3, 3)
    // 28-bit records share a middle byte: the left record takes its high
    // nibble, the right record its low one.
    const middle = buf[at + 3]
    return bit === 0
      ? ((middle & 0xf0) << 20) | buf.readUIntBE(at, 3)
      : ((middle & 0x0f) << 24) | buf.readUIntBE(at + 4, 3)
  }

  return {
    metadata,
    ipVersion: metadata.ip_version,
    databaseType: typeof metadata.database_type === 'string' ? metadata.database_type : '',
    buildEpoch: Number.isFinite(metadata.build_epoch) ? metadata.build_epoch : 0,
    /** @param {Buffer} address 4 or 16 bytes. @returns {object|null} */
    get(address) {
      let node = 0
      const bits = address.length * 8
      for (let i = 0; i < bits && node < nodeCount; i += 1) {
        const bit = (address[i >> 3] >> (7 - (i & 7))) & 1
        node = record(node, bit)
      }
      // Equal to node_count is the format's way of saying "no data here".
      // Below it means the address ran out before the tree did, which a
      // well-formed database never does.
      if (node <= nodeCount) return null
      const at = node - nodeCount - DATA_SEPARATOR_BYTES + dataStart
      if (at < dataStart || at >= buf.length) return null
      return decodeValue(buf, at, dataStart).value
    },
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function ipv4Bytes(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes = Buffer.alloc(4)
  for (let i = 0; i < 4; i += 1) {
    const value = Number(parts[i])
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    bytes[i] = value
  }
  return bytes
}

function ipv6Bytes(text) {
  let value = text
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)

  // A trailing dotted quad — the ::ffff:1.2.3.4 form — becomes the two hextets
  // it stands for, so the rest of the parser only ever sees hexadecimal.
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    const quad = ipv4Bytes(tail)
    if (!quad) return null
    const high = ((quad[0] << 8) | quad[1]).toString(16)
    const low = ((quad[2] << 8) | quad[3]).toString(16)
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  const groups = [...head]
  if (halves.length === 2) {
    const gap = 8 - head.length - rest.length
    if (gap < 0) return null
    for (let i = 0; i < gap; i += 1) groups.push('0')
  }
  groups.push(...rest)
  if (groups.length !== 8) return null

  const bytes = Buffer.alloc(16)
  for (let i = 0; i < 8; i += 1) {
    const group = Number.parseInt(groups[i], 16)
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return null
    bytes.writeUInt16BE(group, i * 2)
  }
  return bytes
}

// Addresses that describe a network rather than a place: loopback, the private
// ranges, carrier-grade NAT, link-local, multicast, and the documentation
// prefixes the panel's demo seed uses. None of them appear in a GeoLite2
// database, and returning null for them saves the tree walk and makes it
// impossible for a fixture to accidentally place one.
function isReserved(v4, v6) {
  if (v4) {
    const [a, b] = v4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    if (a === 192 && b === 0 && v4[2] === 2) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && v4[2] === 100) return true
    if (a === 203 && b === 0 && v4[2] === 113) return true
    return false
  }
  if (!v6) return true
  if (v6.every((byte, i) => (i < 15 ? byte === 0 : byte <= 1))) return true
  if ((v6[0] & 0xfe) === 0xfc) return true
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return true
  if (v6[0] === 0xff) return true
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return true
  return false
}

/**
 * An address in both forms a database might want.
 *
 * A v4-mapped v6 address — ::ffff:1.2.3.4, which is what a dual-stack listener
 * reports for every IPv4 client — is the same visitor as 1.2.3.4 and must
 * resolve to the same place. Both forms are produced here so neither the
 * database's ip_version nor the shape of the string the proxy sent can change
 * the answer.
 */
function parseAddress(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null

  if (isIPv4(text)) {
    const v4 = ipv4Bytes(text)
    if (!v4) return null
    return { v4, v6: Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), v4]) }
  }

  if (!isIPv6(text)) return null
  const v6 = ipv6Bytes(text)
  if (!v6) return null
  const mapped =
    v6.subarray(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff
  return { v4: mapped ? Buffer.from(v6.subarray(12)) : null, v6 }
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

// click_events.asn is a signed 32-bit integer. A value past its ceiling would
// not lose one click, it would abort the whole batch the click travelled in, so
// an autonomous system number nobody routes is dropped instead.
const MAX_ASN = 2_147_483_647

function readCountry(record) {
  const code = record.country?.iso_code ?? record.registered_country?.iso_code
  return typeof code === 'string' && code.length === 2 ? code.toUpperCase() : null
}

function readRegion(record) {
  const first = Array.isArray(record.subdivisions) ? record.subdivisions[0] : null
  if (!first) return null
  const name = first.names?.en ?? first.iso_code
  return typeof name === 'string' && name ? name : null
}

function readCity(record) {
  const name = record.city?.names?.en
  return typeof name === 'string' && name ? name : null
}

function readAsn(record) {
  const asn = record.autonomous_system_number
  return Number.isInteger(asn) && asn > 0 && asn <= MAX_ASN ? asn : null
}

/**
 * Opens one or more MMDB files and answers `country, region, city, asn`.
 *
 * More than one because MaxMind splits the answer: City knows the place, ASN
 * knows the network, and the panel reports both. Each path contributes the
 * fields it has and stays quiet about the rest.
 *
 * Opening is synchronous and forgiving on purpose. Synchronous because
 * `lookup` is called from the collector's synchronous path and an async
 * factory would put a promise where a redirect is being recorded; forgiving
 * because a file that is missing, truncated or garbage must cost the four
 * columns and nothing else.
 *
 * @param {string|string[]} dbPath
 */
export function createGeoLookup(dbPath) {
  const paths = (Array.isArray(dbPath) ? dbPath : [dbPath]).filter(
    (path) => typeof path === 'string' && path
  )
  const databases = []

  for (const path of paths) {
    try {
      databases.push(openDatabase(readFileSync(path)))
    } catch (err) {
      console.warn(`geo: ${basename(path)} is not usable, its fields stay empty: ${err.message}`)
    }
  }

  let open = true

  return {
    /** @returns {{country: string|null, region: string|null, city: string|null, asn: number|null}|null} */
    lookup(ip) {
      if (!open || databases.length === 0) return null

      const address = parseAddress(ip)
      if (!address || isReserved(address.v4, address.v6)) return null

      let country = null
      let region = null
      let city = null
      let asn = null

      for (const db of databases) {
        const bytes = db.ipVersion === 4 ? address.v4 : address.v6
        if (!bytes) continue
        let record
        try {
          record = db.get(bytes)
        } catch {
          // One damaged database must not cost the fields the others hold, and
          // must never cost the click.
          continue
        }
        if (!record || typeof record !== 'object') continue
        country ??= readCountry(record)
        region ??= readRegion(record)
        city ??= readCity(record)
        asn ??= readAsn(record)
      }

      if (country === null && region === null && city === null && asn === null) return null
      return { country, region, city, asn }
    },

    close() {
      open = false
      databases.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Keeping the database on disk
// ---------------------------------------------------------------------------

/**
 * The credential itself, from a string or from anything that reveals one.
 *
 * `core/secret.mjs` is recognised by shape rather than imported: the edge image
 * ships this workspace and two panel modules, and nothing else. An import of a
 * file the container does not hold would not degrade geolocation, it would stop
 * the process that answers every link from starting — which is the one thing an
 * optional feature must never be able to do.
 */
function reveal(value) {
  if (typeof value?.reveal === 'function') return reveal(value.reveal())
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function defaultDirectory() {
  // The temporary directory is the one path writable on both install targets
  // without asking for anything. It also means a redeploy starts from nothing,
  // which is why GEO_DB_DIR exists and why the documentation points a Railway
  // volume at it.
  return process.env.GEO_DB_DIR || join(tmpdir(), 'linkyard-geo')
}

async function readFileMetadata(path) {
  const handle = await openFile(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, METADATA_SCAN_BYTES)
    const tail = Buffer.alloc(length)
    await handle.read(tail, 0, length, size - length)
    const metadata = readMetadata(tail)
    const treeBytes = (metadata.node_count * metadata.record_size * 2) / 8
    if (treeBytes + DATA_SEPARATOR_BYTES >= size) throw new Error('mmdb: file is truncated')
    return metadata
  } finally {
    await handle.close()
  }
}

function builtAtOf(metadata) {
  const epoch = Number(metadata.build_epoch)
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date(0)
}

async function currentDatabase(path) {
  try {
    const metadata = await readFileMetadata(path)
    const { mtimeMs } = await stat(path)
    return { path, builtAt: builtAtOf(metadata), fetchedAt: mtimeMs, databaseType: metadata.database_type }
  } catch {
    return null
  }
}

async function download(fetchImpl, url, credentials, signal) {
  const response = await fetchImpl(url, {
    // Basic auth, never a licence key in a query string: a URL is the one part
    // of a request that ends up in proxy logs and error messages by default.
    headers: {
      authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
      accept: 'application/octet-stream',
      'user-agent': 'linkyard-edge',
    },
    signal,
  })
  if (!response.ok) {
    throw new Error(`download refused with ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive is ${declared} bytes, past the ${MAX_ARCHIVE_BYTES} ceiling`)
  }
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive is ${body.length} bytes, past the ${MAX_ARCHIVE_BYTES} ceiling`)
  }
  return body
}

/**
 * The checksum MaxMind publishes beside the archive, or null.
 *
 * Null is not a failure: it means the structural check is the whole
 * verification. A checksum that arrives and disagrees is a different thing
 * entirely, and the caller stops on it.
 */
async function publishedChecksum(fetchImpl, url, credentials, signal, editionId) {
  try {
    const body = await download(fetchImpl, `${url}.sha256`, credentials, signal)
    const hex = body.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null
  } catch (err) {
    console.warn(`geo: no checksum available for ${editionId}, reading the file is the whole check: ${err.message}`)
    return null
  }
}

// A public address, used once per download to prove the tree can be walked
// before the file is allowed to replace a working one.
const PROBE = {
  v4: Buffer.from([8, 8, 8, 8]),
  v6: Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff, 8, 8, 8, 8])]),
}

// tar is 512-byte headers, each followed by its file padded to the next
// boundary. The archive holds one .mmdb inside a dated directory; everything
// else in it is a licence and a changelog.
function extractDatabase(tar) {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '')
    const size = Number.parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim(), 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('archive header is not readable')
    const kind = header[156]
    const body = offset + 512
    // 0x30 is a regular file and a zero byte is the older way of saying the
    // same thing; every other flag is a directory, a link, or metadata.
    if ((kind === 0x30 || kind === 0) && name.endsWith('.mmdb')) {
      if (body + size > tar.length) throw new Error('archive claims a file longer than itself')
      // A view, not a copy: the archive is already tens of megabytes and this
      // runs inside the process that answers redirects.
      return tar.subarray(body, body + size)
    }
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error('archive contains no .mmdb file')
}

async function writeAtomically(target, bytes) {
  // Temp file, flush, rename. A rename within a directory is atomic, so a
  // reader either sees the database that was there before or the whole new
  // one — never the half of it that had been written when the process died.
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    const handle = await openFile(temporary, 'w')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (err) {
    await unlink(temporary).catch(() => {})
    throw err
  }
}

/**
 * The current GeoLite2 database for one edition, downloading it if it is time.
 *
 * @param {object} [options]
 * @param {string} [options.editionId] `GeoLite2-City`, `GeoLite2-Country` or `GeoLite2-ASN`
 * @param {string} [options.accountId] MAXMIND_ACCOUNT_ID
 * @param {string|{reveal: () => string}} [options.licenseKey] MAXMIND_LICENSE_KEY
 * @param {string} [options.directory] where the .mmdb lives between refreshes
 * @param {number} [options.maxAgeMs] how old the file on disk may get before a refresh
 * @param {number} [options.now] milliseconds, for tests
 * @param {number} [options.timeoutMs] ceiling on the whole download
 * @param {typeof fetch} [options.fetchImpl] for tests
 * @returns {Promise<{path: string, builtAt: Date}|null>} null when there is nothing usable
 */
export async function ensureDatabase({
  editionId = 'GeoLite2-City',
  accountId = process.env.MAXMIND_ACCOUNT_ID,
  licenseKey = process.env.MAXMIND_LICENSE_KEY,
  directory = defaultDirectory(),
  maxAgeMs = WEEK_MS,
  now = Date.now(),
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = join(directory, `${editionId}.mmdb`)
  const existing = await currentDatabase(target)
  const answer = existing ? { path: existing.path, builtAt: existing.builtAt } : null

  // Age is measured from when we last fetched the file, not from MaxMind's
  // build epoch. A database that was already three days old on arrival would
  // otherwise look stale four days later, and the process would ask MaxMind for
  // a new copy roughly twice as often as their terms invite.
  if (existing && now - existing.fetchedAt < maxAgeMs) return answer

  const account = reveal(accountId)
  const key = reveal(licenseKey)
  if (!account || !key) {
    if (!existing) {
      console.log(`geo: no MaxMind credentials, ${editionId} stays unavailable and clicks record without a place`)
    }
    return answer
  }
  // Built once, held in a local, and interpolated into one header. It is
  // never a property of anything that could be logged.
  const credentials = `${account}:${key}`

  const url = `${DOWNLOAD_ORIGIN}/geoip/databases/${encodeURIComponent(editionId)}/download?suffix=tar.gz`
  const signal = AbortSignal.timeout(timeoutMs)

  try {
    const archive = await download(fetchImpl, url, credentials, signal)

    const expected = await publishedChecksum(fetchImpl, url, credentials, signal, editionId)
    if (expected && createHash('sha256').update(archive).digest('hex') !== expected) {
      throw new Error('the archive does not match the checksum MaxMind published for it')
    }

    const database = extractDatabase(await gunzip(archive))

    // Verified before the rename, never after: the file that lands at the
    // target path has already been parsed and walked once.
    const opened = openDatabase(database)
    opened.get(opened.ipVersion === 4 ? PROBE.v4 : PROBE.v6)
    if (opened.databaseType && opened.databaseType !== editionId) {
      console.warn(`geo: asked for ${editionId} and received ${opened.databaseType}`)
    }

    await mkdir(directory, { recursive: true })
    await writeAtomically(target, database)

    const builtAt = new Date(opened.buildEpoch * 1000)
    console.log(`geo: ${editionId} updated, built ${builtAt.toISOString().slice(0, 10)}`)
    return { path: target, builtAt }
  } catch (err) {
    const kept = existing ? ', keeping the copy already on disk' : ', clicks record without a place'
    console.error(`geo: ${editionId} refresh failed${kept}: ${err.message}`)
    return answer
  }
}

function editionsFromEnv(env) {
  const raw = env.GEO_EDITIONS
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_EDITIONS
  return raw
    .split(',')
    .map((edition) => edition.trim())
    .filter(Boolean)
}

/**
 * Keeps the lookup current, forever, without ever being on the click path.
 *
 * MaxMind rebuilds GeoLite2 twice a week; asking once a week is inside their
 * terms and inside the accuracy anyone reads a click report for. Each round
 * opens a new lookup, hands it over, and only then closes the old one, so
 * there is no instant where a click finds nothing loaded.
 *
 * @param {object} [options]
 * @param {string[]} [options.editions]
 * @param {number} [options.intervalMs]
 * @param {number} [options.retryMs] how soon to try again while nothing is loaded
 * @param {(lookup: ReturnType<typeof createGeoLookup>) => void} [options.onReady]
 * @returns {() => void} stop
 */
export function startGeoRefresh({
  editions = editionsFromEnv(process.env),
  intervalMs = WEEK_MS,
  retryMs = 15 * 60 * 1000,
  onReady = () => {},
  ...ensureOptions
} = {}) {
  let stopped = false
  let running = false
  let current = null
  let signature = ''
  let retryTimer = null

  // A weekly cadence is right for a database that changes twice a week. It is
  // the wrong answer to the first attempt failing: MaxMind being briefly
  // unreachable at the moment a service boots would leave every click of the
  // next seven days with no country. Once something is loaded, the ordinary
  // interval takes over and this never runs again.
  function retryUntilSomethingLoads() {
    if (stopped || current || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      refresh()
    }, retryMs)
    retryTimer.unref?.()
  }

  async function refresh() {
    if (stopped || running) return
    running = true
    try {
      const found = []
      for (const editionId of editions) {
        const result = await ensureDatabase({ editionId, ...ensureOptions })
        if (result) found.push(result)
      }
      if (stopped || found.length === 0) return

      const next = found.map((entry) => `${entry.path}@${entry.builtAt.getTime()}`).join('|')
      if (next === signature) return

      const lookup = createGeoLookup(found.map((entry) => entry.path))
      const previous = current
      current = lookup
      signature = next
      onReady(lookup)
      previous?.close()
    } catch (err) {
      // Whatever went wrong, the databases already loaded keep answering.
      console.error(`geo: refresh failed: ${err?.message ?? err}`)
    } finally {
      running = false
      retryUntilSomethingLoads()
    }
  }

  const started = refresh()

  const timer = setInterval(refresh, intervalMs)
  // Geolocation must never be the reason a process refuses to exit.
  timer.unref?.()

  const stop = () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(retryTimer)
    retryTimer = null
    current?.close()
    current = null
  }
  // Exposed for tests, which need to await the first round; nothing on the
  // click path ever waits on it.
  stop.started = started
  return stop
}

/**
 * The handle the collector uses: a lookup that answers null until a database is
 * loaded, and forever if none ever is.
 *
 * Configuration alone turns geolocation on. Without both MaxMind variables
 * nothing is scheduled, nothing is downloaded, and no log line appears —
 * absence is the default state, not a failure.
 */
export function geoFromEnv(env = process.env) {
  if (!env.MAXMIND_LICENSE_KEY || !env.MAXMIND_ACCOUNT_ID) {
    return { enabled: false, lookup: () => null, stop: () => {} }
  }

  let active = null
  const stop = startGeoRefresh({
    editions: editionsFromEnv(env),
    accountId: env.MAXMIND_ACCOUNT_ID,
    licenseKey: env.MAXMIND_LICENSE_KEY,
    onReady: (lookup) => {
      active = lookup
    },
  })

  return {
    enabled: true,
    lookup: (ip) => active?.lookup(ip) ?? null,
    stop: () => {
      active = null
      stop()
    },
  }
}
