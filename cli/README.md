# linkyard

Writes the `.env` a self-hosted [Linkyard](https://github.com/paulotfchaves/linkyard) install runs on.

```bash
npx linkyard install
```

It asks for the panel host, the redirect domain and an email for the TLS
certificate, generates every secret separately, and writes `.env` readable only
by you.

**It talks to no network.** Nothing it produces leaves the machine — there is no
account, no telemetry, and no request of any kind.

Non-interactively:

```bash
npx linkyard install \
  --panel-host panel.example.com \
  --redirect-apex example.com \
  --email you@example.com \
  --yes
```

## What it refuses, and why

**An existing `.env`.** Overwriting it replaces `ENCRYPTION_KEY`, which makes
every credential already stored by that installation unreadable. Pass `--force`
only when that is what you want.

**A template placeholder.** A value containing `${{` is rejected before its
length is even checked. This is not hypothetical: `${{secret(64)}}` is a Railway
*template* function that does not run when services are created directly, and it
once reached configuration verbatim — a 35-character string that satisfied a
length test and would have become the encryption key shared by every install
that shipped it.

**A panel host equal to the redirect apex.** The panel would then occupy the root
of the domain every short link lives under, so `/settings` would be both a page
and a slug somebody could claim.

## Options

| Flag | Meaning |
|---|---|
| `--panel-host <host>` | where the panel answers |
| `--redirect-apex <host>` | the domain short links live under |
| `--email <address>` | for the TLS certificate |
| `--cloudflare-token <token>` | optional; can be added in the panel later |
| `--out <path>` | defaults to `./.env` |
| `--force` | overwrite an existing file |
| `--yes` | fail on a missing answer instead of prompting |

Exit codes: `0` success, `1` refusal, `2` unknown command.

## Full install guide

[docs/INSTALL.md](https://github.com/paulotfchaves/linkyard/blob/main/docs/INSTALL.md)
covers both targets — any Linux VPS via Docker Compose, and Railway.

MIT © Paulo Chaves
