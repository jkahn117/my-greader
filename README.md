# my-greader

A personal RSS aggregator backend running on Cloudflare Workers. Exposes a Google Reader-compatible API so any GReader client (specifically [Current](https://currentapp.app)) can sync against it.

## Stack

- **Runtime**: Cloudflare Workers + D1 (SQLite) + static assets
- **Router**: Hono with JSX server-rendering
- **UI**: htmx (vendored) + Tailwind CSS v4 — no React
- **Feed parsing**: rss-parser
- **Auth**: Cloudflare Access (management UI) + SHA-256 API tokens (GReader clients)
- **Schema/migrations**: Drizzle ORM

## Connecting Current

In Current: **Settings → Sync → FreshRSS**

```
Server URL:  https://<your-worker-domain>
Username:    <your email>
Password:    <API token generated from /app>
```

Current treats this Worker as a FreshRSS instance. It speaks standard GReader protocol — no FreshRSS installation required.

## One-time setup

These steps must be run manually before deploying.

```bash
# 1. Create the D1 database and copy the returned database_id into wrangler.jsonc
wrangler d1 create rss-reader

# 2. Apply schema migrations
wrangler d1 migrations apply rss-reader --local   # local dev
wrangler d1 migrations apply rss-reader --remote  # production

# 3. Set the Cloudflare Access audience tag as a secret
wrangler secret put CF_ACCESS_AUD
```

Then in the Cloudflare dashboard:
- Create an Access application scoped to your Worker's domain
- Set an Access policy allowing only your email
- Copy the Audience Tag into the `CF_ACCESS_AUD` secret above
- Add a custom domain to the Worker and point the Access application at it

## Local development

```bash
pnpm install

# Copy and fill in local secrets
cp .dev.vars.sample .dev.vars
# Set DEV_MODE=true to bypass Cloudflare Access JWT check locally

pnpm dev        # compiles CSS then starts wrangler dev
pnpm test       # run vitest suite
```

The `pnpm dev` script compiles Tailwind CSS once then starts the Worker. For CSS hot-reload during UI development, run `pnpm dev:css` in a separate terminal.

## Deployment

```bash
pnpm deploy     # compiles CSS + vite build + wrangler deploy
```

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Compile CSS, start local Worker dev server |
| `pnpm dev:css` | Watch mode CSS compilation |
| `pnpm build` | Compile CSS + production Worker build |
| `pnpm deploy` | Build + deploy to Cloudflare |
| `pnpm test` | Run vitest suite (42 tests) |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` from wrangler config |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — project structure, D1 schema, cron jobs
- [`docs/auth-flow.md`](docs/auth-flow.md) — Cloudflare Access + API token lifecycle
- [`docs/greader-api.md`](docs/greader-api.md) — GReader endpoint reference
- [`docs/decisions.md`](docs/decisions.md) — rationale behind key technical choices
