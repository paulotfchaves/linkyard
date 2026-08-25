# Installing Linkyard

Linkyard runs as three programs that talk to one database:

| | What it does | If it stops |
|---|---|---|
| **edge** | Answers every short link with a redirect, records the click, and runs scheduled destination swaps | Your links stop working |
| **panel** | The web interface: links, domains, reports, members | Your links keep working; you just cannot change them |
| **postgres** | Holds everything | Both stop |

There are two ways to install it. Pick one:

- **[Railway](#install-on-railway)** — no server to look after. Costs about **US$ 5.50–7.00 a month**. Start here if you have never run a server.
- **[Your own Linux server](#install-on-your-own-server)** — one fixed monthly price for the machine, whatever your provider charges. You keep it patched.

Both need a domain whose DNS is hosted at **Cloudflare**. Linkyard creates the DNS records for your short-link subdomains itself, and Cloudflare is the only DNS provider it knows how to talk to.

---

## Install on Railway

### What Railway is

Railway runs programs for you. You give it a GitHub repository, it builds the program and keeps it running. The vocabulary you will see on screen:

- a **project** is one box holding everything for one installation;
- a **service** is one program inside it — you will have three;
- a **variable** is a setting handed to a service, like a password or a port;
- a **deploy** is one build-and-start of a service. Every change makes a new one.

### What it costs, before you start

Three services, running all month, cost roughly **US$ 5.50 to US$ 7.00**. The exact number moves with how much traffic your links get.

**The US$ 5 Hobby plan does not cover it.** Hobby includes US$ 5 of usage; three always-on services spend more than that, and the difference is billed to your card. This is not a surprise anyone should discover on an invoice, so it is written here, before the button.

If you want to spend less than that, use [your own server](#install-on-your-own-server) instead — a US$ 4–6 VPS runs all three comfortably.

### Steps

**1. Create a Railway account.** Go to [railway.com](https://railway.com) and sign up with GitHub. Add a payment method — without one, Railway will not run three services.

**2. Create the three services.** Use the Linkyard template if you have its link; otherwise create a project and add three services yourself, following `railway-template.json` in this repository. That file lists, for each service, exactly which image or Dockerfile to use and which variables to set.

Two things in it are easy to get wrong and expensive to debug:

- **`DATABASE_URL` must not end in `?sslmode=require`.** Inside a Railway project the services talk over a private network that speaks plain TCP. Asking for TLS there makes Postgres refuse the connection, and the crash looks exactly like the database being down. It is not.
- **`ENCRYPTION_KEY` and `IP_HASH_SALT` must be the *same value* on `edge` and `panel`.** The template has the panel generate them and the edge borrow them. Verify it — see step 4.

**3. Wait for the first deploy.** Each service shows a log. `postgres` starts in seconds. `panel` takes a couple of minutes to build, and on its first start it creates the database tables itself; you will see `migrations applied: 001_identity, ...` in its log. If a deploy fails, the log says why, and the last twenty lines are usually the whole story.

**4. Check the two secrets match.** Open the `panel` service, then **Variables**, and note the value of `ENCRYPTION_KEY`. Open `edge` and compare. They must be identical, 64 characters, hexadecimal.

If the `edge` value instead reads something starting with `${{`, Railway did not resolve the reference. Copy the panel's value into the edge's variable by hand, do the same for `IP_HASH_SALT`, and redeploy the edge. Nothing you have done so far is lost.

**5. Open the panel.** In the `panel` service, under **Settings → Networking**, Railway shows a generated address ending in `.up.railway.app`. Copy `SETUP_TOKEN` from that service's variables and open:

```
https://<your-panel-address>/setup?token=<SETUP_TOKEN>
```

The token is required. Without it that page answers *404 Not Found* — the same answer a stranger gets. (Why: the certificate for your new address is published to a public log within seconds of being issued, and there are people who read that log looking for fresh addresses with an open sign-up page. The token means being first does not help them.)

Create your account. The setup page stops existing the moment it succeeds.

**6. Add your own domain.** Two separate things, in this order:

- *For the panel* — in Railway, `panel` → **Settings → Networking → Custom Domain**. Railway gives you a `CNAME` **and** a `TXT` record named `_railway-verify.<host>`. **Create both.** The TXT is easy to miss and without it the domain sits in "validating ownership" forever with no error shown anywhere. In Cloudflare, set both to **DNS only** (grey cloud), not proxied.
- *For your short links* — do this from the Linkyard panel, not from Railway. Connect your Cloudflare account under **Domains** and add the subdomain there; Linkyard creates the records and requests the certificate for you.

---

## Install on your own server

### What you need

- A Linux machine with a public IPv4 address. 1 vCPU is enough.
- **Memory: 1 GB to run, but the first build needs more than it needs to run.** `docker compose up --build` compiles Caddy from Go source *and* builds the panel. On a 512 MB droplet with no swap that build is killed by the kernel, and the message you get says nothing about memory:

  ```
  failed to execute bake: signal: killed
  ```

  If your machine has under 1 GB, add swap before building — it costs a minute and the build then completes:

  ```bash
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```
- Docker with the Compose plugin. On a fresh Debian or Ubuntu: `curl -fsSL https://get.docker.com | sh`.
- Node 22+ **only if you want the `npx linkyard install` helper below**. A fresh Ubuntu has no Node; the by-hand path in step 2 needs nothing but `openssl`, which is already there.
- A domain whose DNS is at Cloudflare.
- A Cloudflare API token with **Zone → Zone → Read** and **Zone → DNS → Edit** on that zone. Create it at *My Profile → API Tokens → Create Token → Edit zone DNS*, and scope it to the one zone.

### 1. DNS

Point two things at your server's IP address, both **DNS only** (grey cloud) in Cloudflare — a proxied record hides the visitor's IP address and breaks certificate issuance:

| Type | Name | Value |
|---|---|---|
| `A` | `panel` (or whatever you want the panel to answer on) | your server's IP |
| `A` | `*` | your server's IP |

The wildcard is the point of this install path. Because Caddy will hold a wildcard certificate, a brand-new short-link subdomain works the second it exists — no waiting for a certificate per host.

### 2. Configure

```bash
git clone https://github.com/paulotfchaves/linkyard.git
cd linkyard
cp .env.example .env
```

You can write it with one command, or by hand.

**With the command.** It is not published to npm yet, so run it from the clone — which also means you need Node 22+, and a fresh VPS does not have it:

```bash
node cli/src/index.mjs install
```

It asks for the panel host, the redirect domain and an email for the certificate, generates each secret separately, and writes `.env` readable only by you. It talks to no network: nothing it produces leaves the machine. Non-interactively:

```bash
node cli/src/index.mjs install \
  --panel-host panel.example.com \
  --redirect-apex example.com \
  --email you@example.com \
  --yes
```

It refuses to overwrite an existing `.env` without `--force`, because replacing `ENCRYPTION_KEY` makes every credential already stored unreadable.

**By hand:** copy `.env.example` and fill it in. Every variable has a comment above it saying what breaks without it. Generate each of the four secrets — `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `IP_HASH_SALT`, `SETUP_TOKEN` — with its own run of:

```bash
openssl rand -hex 32
```

Do not reuse one value for several variables, and do not invent them by hand.

Then set `LINKYARD_PANEL_HOST` to the panel hostname you created above, `LINKYARD_REDIRECT_APEX` to the apex your short links live under, and `CLOUDFLARE_API_TOKEN` to the token from the previous step.

Leave `DATABASE_URL` alone. `docker-compose.yml` assembles it from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, so the password exists in one place and cannot drift. Set it only if you are pointing Linkyard at a database Compose does not manage — and in that case, do not add `?sslmode=require` unless that server really speaks TLS. A local or private-network Postgres serves plain TCP and refuses the handshake, and the crash looks like an outage.

### 3. Start

```bash
docker compose up -d
docker compose logs -f caddy
```

The first start builds Caddy from source. That is deliberate and takes a couple of minutes: Caddy cannot solve a DNS challenge on its own, so the image is rebuilt with the `caddy-dns/cloudflare` module. Stock `caddy:2-alpine` would start and then fail every certificate with *unrecognized DNS provider: cloudflare*.

Watch for a line saying the certificate was obtained. If it complains about the API token, the token is missing a permission or is scoped to the wrong zone. An empty one says so plainly:

```
API token '' appears invalid; ensure it's correctly entered and not wrapped in braces nor quotes
```

The other three containers do not wait for Caddy, so the panel and the edge are already up and talking to the database while you sort the certificate out.

You may see the edge log `relation "schedules" does not exist` two or three times in the first minute. That is the edge starting before the panel has finished applying migrations; it retries on its own tick and stops within a minute. It is not an error you need to act on.

### 4. First run

Open:

```
https://<LINKYARD_PANEL_HOST>/setup?token=<SETUP_TOKEN>
```

with the token from your `.env`. Create your account. The page then stops existing.

### Keeping it running

```bash
git pull && docker compose up -d --build     # upgrade
docker compose exec postgres pg_dump -U linkyard linkyard > linkyard-$(date +%F).sql
```

The panel applies any new database migrations itself when it starts. Take the backup before an upgrade, not after.

---

## Backing up

```bash
DATABASE_URL=... npm run backup export linkyard-backup.json
```

The file holds what you built: domains, subdomains, links, tags, pending schedules, members and their permissions. It is written readable only by you.

**Cloudflare credentials are deliberately not in it.** They are sealed with this installation's `ENCRYPTION_KEY`, so a copy is unreadable anywhere else — exporting them sealed produces a restore that silently cannot decrypt, and exporting them open turns a backup into a credential leak sitting in whatever bucket you drop it in. Re-enter them in the panel after a restore.

Click history is not included either; it is measured in millions of rows and is not what you need while rebuilding a service. Add `--with-stats` for the daily aggregates if you want your charts back.

Restoring:

```bash
DATABASE_URL=... npm run backup import linkyard-backup.json --dry-run
DATABASE_URL=... npm run backup import linkyard-backup.json
```

The dry run does the whole restore and rolls it back, so what it reports is what would really happen. A restore is a merge, keyed on natural identity — a domain by its apex, a link by host and slug — so running the same file twice changes nothing the second time, and restoring into a database that already has links adds only what is missing.

## When something is wrong

Run the doctor. It checks the things that actually break, prints `PASS` or `FAIL` for each, and tells you the next step for anything that failed.

On your own server:

```bash
docker compose run --rm doctor
```

On Railway, from a checkout of this repository on your machine:

```bash
npm install
railway link                          # pick your project, then the panel service
railway run node scripts/doctor.mjs
```

`railway run` hands your local process the same variables the service has, including `DATABASE_URL`.

What it looks at:

| Check | What a failure means |
|---|---|
| `database` | Whether it can connect at all — and, if not, whether the connection string is asking for TLS from a server that refuses it, or the reverse. This is the single most common cause of "it deployed and immediately crashed". |
| `migrations` | The database schema and the running code are the same age. It reports both directions: tables missing, and a database newer than the code. |
| `clock` | Your server's clock and the database's agree. A scheduled swap fires on the *database's* clock, so a drifting server makes swaps land at the wrong minute. |
| `dns` / `certificate` / `health`, per subdomain | For each short-link host: the name resolves, the certificate is valid, and the edge answers. Told apart on purpose — a name that does not resolve and an edge that is down need completely different fixes. |
| `partitions` | Click storage has a partition for this month and next. Without them clicks still land, in a catch-all the cleanup job cannot remove. |
| `retention` | How many days of clicks are actually stored, against how many you configured. |

It exits non-zero if anything failed, so it can be used in a script or a cron job.

## Two things that are true on both paths

**Your links do not depend on the panel.** If the panel is down, being rebuilt, or misconfigured, every existing short link keeps redirecting. Only editing stops.

**Changing `ENCRYPTION_KEY` destroys stored credentials.** The Cloudflare and Railway tokens the panel holds are encrypted with it. There is no recovery: if you change it, add the credentials again.
