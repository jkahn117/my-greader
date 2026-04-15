# my-greader

A personal RSS aggregator backend running on Cloudflare Workers. Exposes a Google Reader-compatible API so any GReader client (specifically [Current](https://currentapp.app)) can sync against it.

## Stack

- **Runtime**: Cloudflare Workers + D1 (SQLite) + Workflows + static assets
- **Router**: Hono with JSX server-rendering
- **UI**: htmx (vendored) + Tailwind CSS v4 — no React
- **Feed parsing**: rss-parser
- **Auth**: Cloudflare Access (management UI) + SHA-256 API tokens (GReader clients)
- **Schema/migrations**: Drizzle ORM
- **Observability**: `@workers-powertools/logger` (structured logs + correlation IDs), `@workers-powertools/tracer` (per-feed spans), `@workers-powertools/metrics` → Cloudflare Pipelines → R2/Iceberg (long-term analytics)

## Connecting Current and other RSS readers

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
3. Writes a `cycle_runs` row to D1 for the Metrics dashboard
4. Emits named metric events to a Cloudflare Pipeline for long-term analytics

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
pnpm wrangler d1 create rss-reader

# 2. Apply schema migrations
pnpm wrangler d1 migrations apply rss-reader --local   # local dev
pnpm wrangler d1 migrations apply rss-reader --remote  # production

# 3. Set secrets
#    CF_ACCESS_AUD      — Cloudflare Access audience tag (JWT verification)
#    R2_SQL_AUTH_TOKEN  — R2 API token used to query pipeline data via R2 SQL
#
#    To create R2_SQL_AUTH_TOKEN:
#      1. Cloudflare dashboard → R2 Object Storage → Manage R2 API Tokens → Create API token
#      2. Under Permissions, select "Admin Read & Write"
#         (Admin Read only is insufficient — R2 SQL requires write-level access to Data Catalog)
#      3. Optionally scope to the rss-reader-metrics-store bucket
#      4. Copy the token value — it is only shown once
wrangler secret put CF_ACCESS_AUD
wrangler secret put R2_SQL_AUTH_TOKEN

# 4. Create an R2 bucket and enable the Data Catalog (required for R2 SQL queries)
pnpm wrangler r2 bucket create rss-reader-metrics-store
pnpm wrangler r2 bucket catalog enable rss-reader-metrics-store

# 5a. Create the stream (the Worker binding writes to this)
#     The stream name must match the binding name in wrangler.jsonc (underscores, not hyphens)
#     pipeline-schema.json defines the column types for each metric field
pnpm wrangler pipelines streams create rss_reader_metrics_stream \
  --schema-file pipeline-schema.json

# 5b. Create the R2 Data Catalog sink (writes Iceberg tables, queryable via R2 SQL)
#     Retrieve your catalog token: wrangler r2 bucket catalog get rss-reader-metrics-store
pnpm wrangler pipelines sinks create rss_reader_metrics_sink \
  --type r2-data-catalog \
  --bucket rss-reader-metrics-store \
  --namespace rss_reader \
  --table metrics \
  --catalog-token <your-r2-sql-auth-token> \
  --roll-interval 300

# 5c. Create the pipeline connecting the stream to the sink
#     The pipeline name MUST match the "pipeline" value in wrangler.jsonc
pnpm wrangler pipelines create rss_reader_metrics \
  --sql 'INSERT INTO rss_reader_metrics_sink SELECT * FROM rss_reader_metrics_stream'
```

Set `DISPLAY_TIMEZONE` in `wrangler.jsonc` to your local [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `America/Chicago`) so the reads-per-day chart groups by the correct local day.

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

| Script            | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `pnpm dev`        | Compile CSS, start local Worker dev server                      |
| `pnpm dev:css`    | Watch mode CSS compilation                                      |
| `pnpm build`      | Compile CSS + production Worker build                           |
| `pnpm deploy`     | Build + deploy to Cloudflare                                    |
| `pnpm test`       | Run vitest suite (42 tests)                                     |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` from wrangler config     |
| `pnpm studio`     | Open Drizzle Studio against local D1 (run `wrangler dev` first) |
| `pnpm format`     | Format all TypeScript source files with Prettier                |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — project structure, D1 schema, cron jobs
- [`docs/auth-flow.md`](docs/auth-flow.md) — Cloudflare Access + API token lifecycle
- [`docs/greader-api.md`](docs/greader-api.md) — GReader endpoint reference
- [`docs/decisions.md`](docs/decisions.md) — rationale behind key technical choices
