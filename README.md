# Linkyard

Self-hosted redirect and short-link manager. Point your own domains at it, create
short links with UTMs and custom parameters, schedule destination swaps, and see
who clicked — without handing your traffic to a third party.

## Status

Working, not yet released. Both install paths have been run end to end on real
infrastructure: a Docker Compose install on a Linux VPS, with a wildcard
certificate from Let's Encrypt over the Cloudflare DNS challenge, and the
Railway path behind the surfaces linked below.

Not released means: no npm package yet, no published Railway template, no
tagged version. Installing today means cloning this repository.

## Install targets

- **Any Linux VPS** — Docker Compose
- **Railway** — one-click template, CLI, or the hosted setup panel

Running the three services on Railway costs roughly US$ 5.50–7.00 per month.
The US$ 5 Hobby plan does not cover it.

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
