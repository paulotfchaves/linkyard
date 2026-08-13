import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTargetUrl,
  splitUtmsFromUrl,
  validateSlug,
  validateTargetUrl,
  detectsLoop,
  linkStatus,
  RESERVED_SLUGS,
} from '../app/lib/links.server.ts'

test('validateSlug accepts ordinary slugs', () => {
  for (const slug of ['promo', 'spring-2026', 'a', 'v1.2', 'a_b~c']) {
    assert.equal(validateSlug(slug), null, `${slug} should be valid`)
  }
})

test('validateSlug rejects what the edge already owns', () => {
  for (const slug of RESERVED_SLUGS) {
    assert.equal(validateSlug(slug), 'reserved', `${slug} must be reserved`)
  }
  assert.equal(validateSlug('HEALTH'), 'reserved', 'reservation ignores case')
  // A slug carrying a slash is rejected on format first, which is also correct —
  // the well-known rule exists for the slash-free spelling that would otherwise
  // pass the character class.
  assert.equal(validateSlug('.well-known'), 'well_known')
  assert.equal(validateSlug('.well-known/acme'), 'format')
})

test('validateSlug rejects malformed input', () => {
  assert.equal(validateSlug(''), 'empty')
  assert.equal(validateSlug('   '), 'empty')
  assert.equal(validateSlug('has space'), 'format')
  assert.equal(validateSlug('has/slash'), 'format')
  assert.equal(validateSlug('a'.repeat(121)), 'format')
})

test('validateTargetUrl refuses a scheme that could execute', () => {
  assert.equal(validateTargetUrl('https://example.com'), null)
  assert.equal(validateTargetUrl('http://example.com'), null)
  assert.equal(validateTargetUrl(''), 'empty')
  assert.equal(validateTargetUrl('example.com'), 'invalid')
  assert.equal(validateTargetUrl('javascript:alert(1)'), 'scheme')
  assert.equal(validateTargetUrl('data:text/html,<script>'), 'scheme')
})

test('buildTargetUrl appends UTMs to a bare destination', () => {
  const out = buildTargetUrl('https://example.com/page', {
    utm_source: 'youtube',
    utm_medium: 'shorts',
  })
  const url = new URL(out)
  assert.equal(url.searchParams.get('utm_source'), 'youtube')
  assert.equal(url.searchParams.get('utm_medium'), 'shorts')
})

test('buildTargetUrl preserves a query string the destination already had', () => {
  const out = buildTargetUrl('https://example.com/page?ref=partner', { utm_source: 'youtube' })
  const url = new URL(out)
  assert.equal(url.searchParams.get('ref'), 'partner', 'existing parameter survives')
  assert.equal(url.searchParams.get('utm_source'), 'youtube')
})

test('a parameter already in the destination wins over the stored field', () => {
  // The person typed it into the URL last and more specifically. Overwriting it
  // would silently discard an intent the form never showed them.
  const out = buildTargetUrl('https://example.com/page?utm_source=typed', {
    utm_source: 'stored',
  })
  assert.equal(new URL(out).searchParams.get('utm_source'), 'typed')
})

test('buildTargetUrl skips empty and null fields instead of writing blanks', () => {
  const out = buildTargetUrl('https://example.com/', {
    utm_source: 'x',
    utm_medium: '',
    utm_term: null,
  })
  const url = new URL(out)
  assert.equal(url.searchParams.get('utm_source'), 'x')
  assert.equal(url.searchParams.has('utm_medium'), false)
  assert.equal(url.searchParams.has('utm_term'), false)
})

test('buildTargetUrl carries arbitrary custom parameters', () => {
  const out = buildTargetUrl('https://example.com/', {}, { aff: 'partner-7', seat: '12' })
  const url = new URL(out)
  assert.equal(url.searchParams.get('aff'), 'partner-7')
  assert.equal(url.searchParams.get('seat'), '12')
})

test('pass-through fills gaps and never overwrites the link', () => {
  const arriving = new URLSearchParams('utm_source=visitor&gclid=abc123')
  const out = buildTargetUrl(
    'https://example.com/',
    { utm_source: 'link' },
    {},
    arriving
  )
  const url = new URL(out)
  assert.equal(url.searchParams.get('utm_source'), 'link', 'the link declared it, so it wins')
  assert.equal(url.searchParams.get('gclid'), 'abc123', 'unclaimed parameter passes through')
})

test('buildTargetUrl keeps the fragment intact', () => {
  const out = buildTargetUrl('https://example.com/page#section', { utm_source: 'x' })
  assert.ok(out.endsWith('#section'), `fragment lost: ${out}`)
})

test('splitUtmsFromUrl pulls tracking out of a pasted URL', () => {
  const result = splitUtmsFromUrl(
    'https://example.com/lp?utm_source=ig&utm_campaign=launch&ref=partner'
  )
  assert.ok(result)
  assert.equal(result.base, 'https://example.com/lp?ref=partner')
  assert.equal(result.utms.utm_source, 'ig')
  assert.equal(result.utms.utm_campaign, 'launch')
})

test('splitUtmsFromUrl returns null when there is nothing to split', () => {
  assert.equal(splitUtmsFromUrl('https://example.com/lp'), null)
  assert.equal(splitUtmsFromUrl('https://example.com/lp?ref=x'), null)
  assert.equal(splitUtmsFromUrl('not a url'), null)
})

test('splitUtmsFromUrl leaves no orphan question mark', () => {
  const result = splitUtmsFromUrl('https://example.com/lp?utm_source=ig')
  assert.ok(result)
  assert.equal(result.base, 'https://example.com/lp')
})

test('detectsLoop catches a destination pointing back at this installation', () => {
  const hosts = ['go.example.com', 'links.example.com']
  assert.equal(detectsLoop('https://go.example.com/other', hosts), true)
  assert.equal(detectsLoop('https://GO.example.com/other', hosts), true, 'host match ignores case')
  assert.equal(detectsLoop('https://example.com/page', hosts), false)
  assert.equal(detectsLoop('not a url', hosts), false)
})

test('linkStatus reads expiry before anything else', () => {
  const past = new Date(Date.now() - 1000)
  const future = new Date(Date.now() + 86_400_000)

  assert.equal(linkStatus({ active: true, expires_at: past }), 'expired')
  assert.equal(
    linkStatus({ active: false, expires_at: past }),
    'expired',
    'an expired link reads expired even when paused'
  )
  assert.equal(linkStatus({ active: false, expires_at: null }), 'paused')
  assert.equal(linkStatus({ active: true, expires_at: future, scheduled: true }), 'scheduled')
  assert.equal(linkStatus({ active: true, expires_at: null }), 'active')
})
