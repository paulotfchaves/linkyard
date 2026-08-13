# Linkyard — Product Context

> Written from the approved design spec rather than a live interview: the interview
> happened in the session that produced `docs/superpowers/specs/2026-08-13-linkyard-design.md`,
> and every answer below is a decision recorded there.

## What it is

A self-hosted redirect and short-link manager. You point your own domains at it, create short
links carrying UTMs and custom parameters, schedule destination swaps, and see who clicked —
without handing your traffic to a third party.

Positioning: the open-source Switchy.io, with one thing no hosted competitor offers — domain
provisioning that runs end to end (DNS + infrastructure + certificate) instead of handing the
operator a CNAME and wishing them luck.

## Who uses it

**The operator** installs it once. Often not an engineer: someone running paid traffic, launches,
or an agency, who owns domains and needs links that survive a campaign. They will meet DNS,
certificates, and a Railway bill — and the product's job is to make none of that hurt.

**The team member** works inside it daily. Creates links, swaps destinations before a launch,
checks what converted. They live in a table and want it fast, dense, and forgiving.

**The click** never sees the product. It sees a 302 in under 50ms. This is the only user whose
experience is non-negotiable.

## What success looks like

- A non-technical operator installs, connects Cloudflare, and has a working short link on their
  own domain in under ten minutes, without reading documentation.
- A team member swaps the destination of 300 links before a launch without leaving the table.
- Nobody is surprised by a Railway invoice.
- A redirect domain never gets flagged by a malware scanner because its root answered 404.

## Constraints that shape the design

- **Two install targets:** any Linux VPS (Docker Compose) and Railway (three services). Three
  services on Railway cost roughly US$ 5.50–7.00/month; the US$ 5 Hobby plan does not cover it,
  and the product says so before the deploy, not after the invoice.
- **Bilingual application, English repository.** UI, onboarding, and errors ship in pt-BR and
  en-US. Code, comments, commits, and docs are EN-US only.
- **No SaaS dependency.** Authentication, sessions, and secrets are the product's own. A
  self-hosted tool that dies when someone else's service dies is not self-hosted.
- **Single tenant, many members.** One installation belongs to one organisation. Roles are
  `owner`, `admin`, `editor`, `viewer`, and grants only ever widen what a role allows.
- **The edge is sacred.** The redirect service holds no dependency it does not need and never
  serves panel HTML. If the panel is down, every link still resolves.

## What it is not

- Not a public, anonymous link shortener. Every link is created by an authenticated member and
  recorded in an audit trail.
- Not a URL proxy. No endpoint accepts a destination from a query string, so it can never be
  turned into an open redirect.
- Not multi-tenant SaaS.

## Surfaces

| Surface | Mode | Who |
|---|---|---|
| Panel (links, domains, analytics, members) | Operate | Team member, daily |
| First-run setup | Onboard | Operator, once |
| Hosted setup panel at `linkyard.paulochaves.dev` | Operate | Prospective operator, once |
| Public demo | Experience | Someone deciding whether to install |
