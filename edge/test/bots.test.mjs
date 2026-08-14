import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBot } from '../src/bots.mjs'

// Every string here was copied from a request a real agent sends. A hand-written
// approximation of a User-Agent proves nothing: the whole value of this module
// is that it matches what actually arrives, and the two most expensive bugs in
// the class are both invisible to invented strings — see the Telegram and CUBOT
// cases below.

test('WhatsApp preview fetch is a bot', () => {
  assert.deepEqual(classifyBot('WhatsApp/2.23.20.0 A'), { isBot: true, kind: 'whatsapp' })
  assert.deepEqual(classifyBot('WhatsApp/2.2314.11 N'), { isBot: true, kind: 'whatsapp' })
})

test('Meta crawlers are bots under all three of their names', () => {
  assert.equal(
    classifyBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)').kind,
    'facebook'
  )
  assert.equal(classifyBot('Facebot').kind, 'facebook')
  assert.equal(
    classifyBot(
      'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
    ).kind,
    'facebook'
  )
})

// Telegram's fetcher literally announces itself as "like TwitterBot". Matching
// Twitter first would file every Telegram preview under the wrong platform, and
// the report would show traffic from a network the campaign never ran on.
test('Telegram is not misfiled as Twitter despite saying TwitterBot', () => {
  assert.deepEqual(classifyBot('TelegramBot (like TwitterBot)'), {
    isBot: true,
    kind: 'telegram',
  })
})

test('Twitter, Slack, Discord, LinkedIn and Skype previews are bots', () => {
  assert.equal(classifyBot('Twitterbot/1.0').kind, 'twitter')
  assert.equal(classifyBot('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)').kind, 'slack')
  assert.equal(classifyBot('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)').kind, 'discord')
  assert.equal(
    classifyBot('LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)').kind,
    'linkedin'
  )
  assert.equal(classifyBot('SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com').kind, 'skype')
})

test('search engine crawlers are bots', () => {
  assert.equal(classifyBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').kind, 'google')
  assert.equal(classifyBot('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)').kind, 'bing')
})

test('command-line tools and headless browsers are bots', () => {
  assert.equal(classifyBot('curl/8.7.1').kind, 'tool')
  assert.equal(classifyBot('Wget/1.21.4').kind, 'tool')
  assert.equal(
    classifyBot(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/121.0.6167.85 Safari/537.36'
    ).kind,
    'headless'
  )
})

test('an unknown self-declared crawler still classifies as a bot', () => {
  assert.deepEqual(classifyBot('Applebot/0.1; +http://www.apple.com/go/applebot'), {
    isBot: true,
    kind: 'generic',
  })
  assert.equal(classifyBot('SomeNew-Crawler/3.2 (+https://example.com/crawler)').kind, 'generic')
})

test('real people are not bots', () => {
  const humans = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  ]
  for (const ua of humans) {
    assert.deepEqual(classifyBot(ua), { isBot: false, kind: null }, ua)
  }
})

// CUBOT is a phone brand that ships in the Android User-Agent. A substring match
// on "bot" flags every one of those handsets as a preview fetcher and deletes a
// real audience from the report.
test('a phone whose brand name contains "bot" is still a person', () => {
  const ua =
    'Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.104 Mobile Safari/537.36'
  assert.deepEqual(classifyBot(ua), { isBot: false, kind: null })
})

// A browser without a User-Agent does not exist, but a person behind a
// header-stripping privacy proxy does. Guessing "no agent, therefore a bot"
// removes that person from every total; guessing the other way costs nothing
// but one over-counted click.
test('a missing User-Agent is treated as a person, not a bot', () => {
  assert.deepEqual(classifyBot(''), { isBot: false, kind: null })
  assert.deepEqual(classifyBot(undefined), { isBot: false, kind: null })
  assert.deepEqual(classifyBot(null), { isBot: false, kind: null })
})
