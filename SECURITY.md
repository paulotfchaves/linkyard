# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/paulotfchaves/linkyard/security/advisories/new).
Please do not open a public issue for anything exploitable.

Expect a first reply within a week. This is a personal project, not a company
with an on-call rota — that is the honest expectation to set rather than a
service level nobody is standing behind.

## What an installation holds

Worth knowing before you deploy it, and worth knowing if you are looking for
something to report:

**Cloudflare API tokens**, sealed with AES-256-GCM under a key derived from the
installation's `ENCRYPTION_KEY`. That key lives in the environment, never in the
database, so a database dump on its own does not yield the tokens. It is also
why `scripts/backup.mjs` does not export credentials: sealed they would be
unreadable elsewhere, and open they would turn a backup into a leak.

**Password hashes**, Argon2id with `memoryCost` 19456, `timeCost` 2.

**No visitor IP addresses.** The click pipeline stores an HMAC of the address
under a per-installation salt, never the address itself.

## Decisions that are deliberate, so you know what is not a bug

**Redirects are 302, never 301.** A permanently cached redirect means the next
destination change never reaches anyone who already clicked, which defeats the
product. Every redirect also carries `Cache-Control: no-store`.

**`/setup` answers 404 without a valid token**, not 401 or 405. A 405 would
confirm the path exists, which is the first useful thing to learn about an
endpoint. The install-counter Worker behaves the same way.

**The panel refuses a Cloudflare token that can see more than one zone.** A
token scoped to fifty domains stored by a redirect service is a blast radius
nobody needs.

**`X-Forwarded-For` is read from the right.** The leftmost entry is whatever the
client sent, so trusting it would let any visitor choose their own country and
appear as many unique visitors. `TRUSTED_PROXY_HOPS` controls how far right.

**Failed sign-ins are throttled per address and source**, and an unknown address
costs the same time as a wrong password — a miss verifies against a real hash so
the response time cannot be used to discover who has an account.

## Scope

In scope: the panel, the edge, the setup service, the installers, and anything
in this repository.

Out of scope: the demo instance at `demo.linkyard.paulochaves.dev`, which is
seeded with fictional data and reset regularly, and vulnerabilities in Railway,
Cloudflare, or Postgres themselves.
