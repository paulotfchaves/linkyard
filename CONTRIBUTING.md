# Contributing

## Running it

Node 22+ and a Postgres 14+ you can create databases in.

```bash
npm install
createdb linkyard_dev
DATABASE_URL=postgres://localhost:5432/linkyard_dev npm run migrate
createdb linkyard_test
npm test
```

Tests talk to a real Postgres. There are no database mocks anywhere in this
repository, on purpose: most of the defects worth catching here are about what
Postgres actually does — partition routing, `FOR UPDATE SKIP LOCKED`, partial
unique indexes, the exact shape of a constraint violation — and a mock agrees
with whatever the author believed at the time.

Each test file gets its own schema inside `linkyard_test`, so files cannot see
each other's tables even in the same process.

## Before you open a pull request

```bash
npm test
npm run scan
```

`npm run scan` is the publication gate. It sweeps the working tree **and the
full git history** for brand names, personal data and secrets, and it is not
advisory — CI runs it and a red gate blocks the merge. Run it before every
commit, not just before pushing: a file added and removed in a later commit is
still in the history, and that is exactly the case it exists to catch.

If you add a workspace, run `npm install` and commit `package-lock.json` with
it. There is a test for this because forgetting it has cost two red builds:
everything passes locally, since `node_modules` already has the workspace
linked, and only `npm ci` notices.

## What the codebase expects of a change

**Explain the "why" where it is not obvious, and not the "what".** Most comments
here exist because something was wrong once and the fix looks arbitrary without
the story. If your change removes the reason a comment exists, remove the
comment too.

**Prove a fix with a test that fails without it.** The most useful tests in this
repository were written by first reproducing the defect — a timing gap of two
orders of magnitude, a Postgres mount that refuses to start, a seed whose
launch spike only read as a spike on some days of the week.

**Verify against the real thing when the real thing is reachable.** The
Cloudflare provider was fully unit-tested and still had three defects that only
appeared against the live API. The Compose install passed every test and could
never have started, because the suite talks to a Postgres it did not launch.

## Style

There is no linter config to satisfy; match the file you are editing. Two
conventions are load-bearing:

- Imports carry explicit `.ts` / `.mjs` extensions. Node's type stripping needs
  them, and without them a test file aborts at load — which once left 102 tests
  silently not running while the count stayed green.
- Server-only modules end in `.server.ts` so the bundler keeps them off the
  client.

## Design changes

`DESIGN.md` describes the visual system and, more usefully, the reasons behind
it. If a change contradicts it, say so in the pull request and why — the
document is meant to be argued with, not worked around.

MIT © Paulo Chaves
