# Publishing a Railway template

Linkyard has no published one-click template, and this describes how to make
one — for anyone running their own copy, or for a later change of mind here.

Two things force it to be done by hand. The API can only turn an **existing
project** into a template (`templateGenerate(projectId)`), so publishing that
way means deploying the three services somewhere first and paying for them. And
a published template carries a `creator`, an avatar and a `totalPayout`
account, so it has to be published from the account that should be credited —
not from whichever one happens to have a plan attached.

The web editor builds the recipe without running anything. Go to
**railway.com/new/template**, signed in as the account that should own it, and
add three services.

## 1. postgres

| Field | Value |
|---|---|
| Source | Docker image `postgres:18-alpine` |
| Volume mount path | `/var/lib/postgresql/data` |

Variables:

```
POSTGRES_USER      linkyard
POSTGRES_DB        linkyard
POSTGRES_PASSWORD  ${{secret(64, "abcdef0123456789")}}
PGDATA             /var/lib/postgresql/data/pgdata
```

`PGDATA` is not optional and not cosmetic. A Railway volume arrives non-empty —
it carries `lost+found` — and `initdb` refuses to run into a non-empty
directory, so the data has to live one level down.

It is also why this mount path is correct here while the identical path was
wrong in `docker-compose.yml`. Postgres 18 refuses to start when it finds a
cluster at the legacy location; with `PGDATA` pointing at a subdirectory, the
mount itself holds no cluster and the check passes. Compose had no such
variable, so it broke every install until the mount moved to
`/var/lib/postgresql`. Same path, opposite verdict, because of this one line.

No healthcheck: Railway probes over HTTP and Postgres does not speak it.

## 2. panel

| Field | Value |
|---|---|
| Source | GitHub repo `paulotfchaves/linkyard` |
| Dockerfile path | `panel/Dockerfile` |
| Public networking | generate a domain, target port `3000` |
| Healthcheck | **none** |
| Restart policy | on failure |

Variables:

```
DATABASE_URL     postgresql://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}
PORT             3000
ENCRYPTION_KEY   ${{secret(64, "abcdef0123456789")}}
SETUP_TOKEN      ${{secret(64, "abcdef0123456789")}}
IP_HASH_SALT     ${{secret(64, "abcdef0123456789")}}
PANEL_ORIGIN     https://${{RAILWAY_PUBLIC_DOMAIN}}
INFRA_PROVIDER   railway
NODE_ENV         production
```

The panel owns the three secrets because it is the service that seals
credentials; the edge borrows two of them by reference rather than generating
its own, which would leave each service unable to read what the other wrote.

**No `?sslmode=require`** on `DATABASE_URL`. Railway's private network speaks
plain TCP and rejects the handshake, and the crash reads like an outage.

**The absent healthcheck is deliberate.** The panel serves no health route, and
a check aimed at a 404 fails the deploy after the 300-second timeout — so
declaring one would break the very first deploy of every install.

## 3. edge

| Field | Value |
|---|---|
| Source | GitHub repo `paulotfchaves/linkyard` |
| Dockerfile path | `edge/Dockerfile` |
| Healthcheck | `/healthz` |
| Restart policy | on failure |

Variables:

```
DATABASE_URL     postgresql://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}
PORT             3100
ENCRYPTION_KEY   ${{panel.ENCRYPTION_KEY}}
IP_HASH_SALT     ${{panel.IP_HASH_SALT}}
NODE_ENV         production
```

The edge gets no generated domain here. Its hostnames are the redirect
subdomains, added later from the panel as custom domains.

## 4. Publish

| Field | Value |
|---|---|
| Name | Linkyard |
| Category | Web / Tools |
| Description | Self-hosted redirect and short-link manager with automatic domain provisioning. |
| Readme | point at the repository README |

State the cost in the description or the readme: three services run about
US$ 5.50-7.00 a month, and the US$ 5 Hobby plan does not cover them. The setup
panel says this before it deploys anything, and the template page should not be
the one place that stays quiet about it.

## After publishing

Add the deploy button to `README.md`, and drop the "no deploy button" note from
`docs/INSTALL.md`:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/YOUR_TEMPLATE_CODE)
```

The code is the last segment of the published template's URL.
