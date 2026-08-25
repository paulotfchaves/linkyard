<img src="docs/mark.svg" alt="" width="132" height="132" align="right">

# Linkyard

Self-hosted redirect and short-link manager. Point your own domains at it, create
short links with UTMs and custom parameters, schedule destination swaps, and see
who clicked — without handing your traffic to a third party.

## Status

Working, not yet released. Both install paths have been run end to end on real
infrastructure: a Docker Compose install on a Linux VPS, with a wildcard
certificate from Let's Encrypt over the Cloudflare DNS challenge, and the
Railway path behind the surfaces linked below.

## Install

**Any Linux VPS**, with Docker Compose:

```bash
git clone https://github.com/paulotfchaves/linkyard.git
cd linkyard
cp .env.example .env      # then fill it in — docs/INSTALL.md walks through it
docker compose up -d
```

The repository also ships `cli/`, which writes that `.env` for you: it generates
each secret separately, sets the file owner-only, and talks to no network. It is
not on npm yet, so run it from the clone with `node cli/src/index.mjs install`.

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
