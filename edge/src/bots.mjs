// Bot classification, by User-Agent alone.
//
// This is a requirement rather than a refinement. WhatsApp, Meta, Telegram,
// Slack, Discord and Twitter all issue a GET the moment somebody pastes a link
// into a conversation, before any human decides whether to tap it. Counting
// those fetches as clicks is the single most common way a short-link report
// becomes useless, and it is the loudest complaint from people who run paid
// traffic through a shortener.
//
// Bots are recorded, never dropped: the row lands with is_bot = true and stays
// out of the default totals, so an operator can still ask how many previews a
// post generated.

// Order is the whole design here. Every rule below is checked in sequence and
// the first match wins, so the specific agents come before the families they
// impersonate, and the catch-all comes last.
const RULES = [
  // Telegram announces itself as "TelegramBot (like TwitterBot)". Twitter first
  // would file every Telegram preview under a network the campaign never ran on.
  { kind: 'telegram', re: /telegrambot/i },
  { kind: 'whatsapp', re: /whatsapp/i },
  { kind: 'facebook', re: /facebookexternalhit|facebookcatalog|facebot|meta-externalagent|meta-externalfetcher/i },
  { kind: 'slack', re: /slackbot|slack-imgproxy/i },
  { kind: 'discord', re: /discordbot/i },
  { kind: 'twitter', re: /twitterbot/i },
  { kind: 'linkedin', re: /linkedinbot/i },
  { kind: 'skype', re: /skypeuripreview/i },
  {
    kind: 'google',
    re: /googlebot|google-inspectiontool|adsbot-google|mediapartners-google|apis-google|feedfetcher-google|google-read-aloud|storebot-google|googleother/i,
  },
  { kind: 'bing', re: /bingbot|bingpreview|adidxbot|msnbot/i },
  { kind: 'tool', re: /^curl\/|^wget\/|\bcurl\/|\bwget\/|python-requests|go-http-client|okhttp|axios\/|node-fetch|libwww-perl|java\/\d/i },
  { kind: 'headless', re: /headlesschrome|phantomjs|puppeteer|playwright|electron\//i },
  // A crawler nobody has met yet still says so. "bot" is matched only as a whole
  // word or as a version-bearing token: CUBOT is a phone brand that ships inside
  // the Android User-Agent, and a substring match deletes those handsets from
  // every report.
  { kind: 'generic', re: /\b(bot|crawler|spider|crawling|scraper|fetcher)\b|bot\/\d|-bot\b/i },
]

/**
 * @param {string|null|undefined} userAgent
 * @returns {{ isBot: boolean, kind: string|null }}
 */
export function classifyBot(userAgent) {
  // No browser omits a User-Agent, but a person behind a header-stripping
  // privacy proxy does. Guessing "no agent, therefore a bot" erases that person
  // from every total; guessing the other way costs one over-counted click.
  if (typeof userAgent !== 'string' || !userAgent.trim()) return { isBot: false, kind: null }

  for (const rule of RULES) {
    if (rule.re.test(userAgent)) return { isBot: true, kind: rule.kind }
  }
  return { isBot: false, kind: null }
}
