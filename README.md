# my-greader

A personal RSS aggregator backend running on Cloudflare Workers. Exposes a Google Reader-compatible API so any GReader client (specifically [Current](https://currentapp.app)) can sync against it.

## Stack

- **Runtime**: Cloudflare Workers + D1 (SQLite) + Workflows + static assets
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

## Feed polling

Feeds are fetched via a **Cloudflare Workflow** triggered every 30 minutes. Each run:

1. Queries feeds whose poll interval has elapsed (stale-first ordering)
2. Processes them in sequential batches of 20, fetching each batch concurrently
3. Emits a `cycle` event to Analytics Engine for the Metrics dashboard

**Adaptive backoff** — `check_interval_minutes` per feed, default 30 min:

- New content found → reset to 30 min (or feed's `<ttl>` if longer)
- No new content / 304 → interval doubles, capped at 4 hours
- Feed-supplied `<ttl>` is respected as a floor (up to 24 hours)
- Errors do not affect the interval — feeds retry at the same frequency

Workflows are used rather than a plain cron loop because each sequential step runs in its
own Worker invocation with a fresh subrequest budget, bypassing the 50-subrequest-per-invocation
limit on the free plan.

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

# 4. Set the Cloudflare API token for the status dashboard (Analytics Engine Read)
wrangler secret put CF_API_TOKEN
```

**Creating the `CF_API_TOKEN`:**

1. Go to [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens) → **My Profile → API Tokens → Create Token**
2. Use **Create Custom Token**
3. Set permissions:
   - `Account` → `Account Analytics` → **Read**
4. Set **Account Resources** → Include → your account
5. Copy the generated token and run `wrangler secret put CF_API_TOKEN`

Also set your account ID as a var in `wrangler.jsonc` under `CF_ACCOUNT_ID` (found in the Cloudflare dashboard sidebar).

**Cloudflare Access setup:**

Access must protect the management UI while allowing Current to reach the GReader API without a browser session. Do this with two Access applications on the same subdomain, matched by path. Access evaluates most-specific path first.

**App 1 — GReader API bypass** (create this first)
1. Zero Trust → Access → Applications → Add an application → **Self-hosted**
2. Application domain: `reader.iamjkahn.com`, path: `/api/greader.php/*`
3. Add a policy — **critical**: set **Action = Bypass** (not Allow), Include = **Everyone**
   > If Action is not set to Bypass, Access will redirect API requests to the login page
4. No audience tag needed — this app does not issue JWTs

**App 2 — Management UI** (catch-all)
1. Add another Self-hosted application
2. Application domain: `reader.iamjkahn.com` (no path — catches everything else)
3. Add a policy: **Action = Allow**, Include = **Emails** → your email address
4. Copy the **Audience Tag** from this application's settings
5. Run `wrangler secret put CF_ACCESS_AUD` and paste the tag

Also add a custom domain to the Worker in the Cloudflare dashboard and point both Access applications at it.

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
| `pnpm studio` | Open Drizzle Studio against local D1 (run `wrangler dev` first) |
| `pnpm format` | Format all TypeScript source files with Prettier |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — project structure, D1 schema, cron jobs
- [`docs/auth-flow.md`](docs/auth-flow.md) — Cloudflare Access + API token lifecycle
- [`docs/greader-api.md`](docs/greader-api.md) — GReader endpoint reference
- [`docs/decisions.md`](docs/decisions.md) — rationale behind key technical choices
