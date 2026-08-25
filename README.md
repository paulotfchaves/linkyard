<img src="docs/mark.svg" alt="" width="132" height="132" align="right">

# Linkyard

Self-hosted redirect and short-link manager. Point your own domains at it, create
short links with UTMs and custom parameters, schedule destination swaps, and see
who clicked — without handing your traffic to a third party.

[![npm](https://img.shields.io/npm/v/linkyard)](https://www.npmjs.com/package/linkyard)
[![CI](https://github.com/paulotfchaves/linkyard/actions/workflows/ci.yml/badge.svg)](https://github.com/paulotfchaves/linkyard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Status

Working. Both install paths have been run end to end on real
infrastructure: a Docker Compose install on a Linux VPS, with a wildcard
certificate from Let's Encrypt over the Cloudflare DNS challenge, and the
Railway path behind the surfaces linked below.

The one-click Railway template is not published yet; the other three ways in —
Compose, the CLI, and the hosted setup panel — are.

## Install

**Any Linux VPS**, with Docker Compose:

```bash
git clone https://github.com/paulotfchaves/linkyard.git
node linkyard/cli/src/index.mjs install --out linkyard/.env
cd linkyard && docker compose up -d
```

The clone already contains the installer, so it runs straight from there and
needs nothing fetched. Without a clone — to generate a `.env` for a machine you
will provision some other way — the same tool is on npm:

```bash
npx linkyard install
```

`npx linkyard install` talks to no network — it generates each secret
separately, writes the file owner-only, and nothing it produces leaves your
machine. If you would rather do it by hand, copy `.env.example` instead;
[docs/INSTALL.md](docs/INSTALL.md) walks through every variable.

**Railway**, three services. See [docs/INSTALL.md](docs/INSTALL.md) for both
paths in full, including the DNS records and the Cloudflare token scope.

Running the three services on Railway costs roughly US$ 5.50-7.00 per month.
The US$ 5 Hobby plan does not cover it, and the installer says so before it
deploys anything.

## Development

Requires Node 22+ and a Postgres 14+ instance.

```bash
npm install
createdb linkyard_dev
DATABASE_URL=postgres://localhost:5432/linkyard_dev npm run migrate
npm test
```

Tests need a database of their own:

```bash
createdb linkyard_test
npm test
```

Set `TEST_DATABASE_URL` if it does not live at
`postgres://localhost:5432/linkyard_test`.

## License

MIT
