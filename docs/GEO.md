# Where your clicks come from

Linkyard can tell you which country a click came from. It is off until you say
otherwise, and everything else works exactly the same either way.

## What you get, and what you lose without it

With it, every click records a **country, a region, a city and the network**
(the ASN — roughly, which internet provider the visitor was on). The **Countries**
list on the Reports tab is built from that. Region, city and network are stored
alongside it and are there when you export.

Without it, those four fields stay empty and nothing else changes: links
redirect, clicks are counted, uniques are counted, bots are filtered, and every
other breakdown — device, browser, referrer, language — is unaffected. The
Countries list is simply empty.

This is worth saying plainly because it is easy to assume a missing setting
breaks something. It does not. If the key is wrong, or MaxMind is down, or the
file gets corrupted, the answer is always the same: those four fields are blank
and your links keep working.

## Why you have to fetch it yourself

The country data comes from **GeoLite2**, a free database published by MaxMind.
Their licence does not allow anyone to redistribute it inside a public
repository, so it is not in this one. Each installation downloads its own copy,
with its own credentials. That is the only reason this page exists.

## Getting a key

1. Go to [maxmind.com](https://www.maxmind.com/en/geolite2/signup) and sign up
   for **GeoLite2**. It is free. You will be asked what you plan to use it for;
   "self-hosted link analytics" is an accurate answer.
2. Confirm the email they send and set a password.
3. In your account, open **Manage License Keys** and create one. **Copy it
   immediately** — MaxMind shows it once and never again.
4. On the same page, note your **Account ID**. It is a number, usually six or
   seven digits.

You now have the two values Linkyard needs.

## Setting it up

Add both to the **edge** service — the one that answers your links. Nothing else
needs them.

```
MAXMIND_ACCOUNT_ID=123456
MAXMIND_LICENSE_KEY=the-key-you-copied
```

On Railway: open the `edge` service, **Variables**, add the two, and let it
redeploy. On your own server: add them to the `.env` file next to
`docker-compose.yml` and run `docker compose up -d edge`.

Within a minute of starting you should see this in the edge log:

```
geo: GeoLite2-City updated, built 2026-08-12
geo: GeoLite2-ASN updated, built 2026-08-12
```

Clicks recorded from that moment carry a country. **Clicks recorded before it do
not** — nothing is filled in retroactively, because the address they came from
was never kept.

## Two settings you probably do not need

**`GEO_DB_DIR`** — where the downloaded database is kept. By default it goes to
the machine's temporary directory, which on Railway is wiped by every deploy, so
each deploy downloads it again. That is fine for most people. If you deploy many
times a day, attach a volume and point this at it:

```
GEO_DB_DIR=/data/geo
```

**`GEO_EDITIONS`** — which databases to use. The default is:

```
GEO_EDITIONS=GeoLite2-City,GeoLite2-ASN
```

The City database is about 60 MB and is held in memory, which is the real cost
of this feature. If your edge service is on a small plan and you only care about
countries, use the smaller edition instead — it costs about a tenth of the
memory and gives up the region and city:

```
GEO_EDITIONS=GeoLite2-Country,GeoLite2-ASN
```

## How it stays current

MaxMind rebuilds GeoLite2 twice a week. Linkyard checks once a week, downloads
in the background, verifies the file against the checksum MaxMind publishes,
opens it to confirm it is readable, and only then puts it in place — with a
single rename, so a half-written file can never be read. If any step fails, the
copy already in use keeps answering and the log says what went wrong. If the
very first attempt fails — MaxMind unreachable in the minute your service
happened to start — it tries again a quarter of an hour later rather than
waiting out the week.

None of this happens while someone is waiting for a redirect. The lookup itself
runs after the visitor has already been sent on their way.

## What is stored about a visitor

The visitor's IP address is used to look up the place and is then discarded. It
is never written to the database, never written to a log line, and never kept in
memory beyond the moment it is read. What the click record holds is a one-way
hash of the address — enough to tell two visitors apart, useless for identifying
either — plus the country, region, city and network.

Private and internal addresses are never looked up at all.

## When something looks wrong

| In the log | What it means |
|---|---|
| `download refused with 401` | The account ID or the licence key is wrong. Check for a trailing space. |
| `download refused with 403` | The key is valid but not entitled to that edition. Confirm you signed up for GeoLite2. |
| `no checksum available` | Harmless. MaxMind did not serve the checksum; the file was still opened and checked before use. |
| `refresh failed, keeping the copy already on disk` | Something went wrong and the database you already had is still in use. Nothing is broken. |
| `is not usable, its fields stay empty` | The file on disk is damaged. It will be replaced on the next refresh; delete it to force one sooner. |
| Nothing at all | Neither variable is set. Geolocation is off, which is the default. |

If countries are still empty an hour after the log said `updated`, the likely
cause is that your edge service is not seeing real visitor addresses — check
that it sits behind exactly the number of proxies `TRUSTED_PROXY_HOPS` says it
does.
