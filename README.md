# my-greader

A personal RSS aggregator backend running on Cloudflare Workers. Exposes a Google Reader-compatible API so any GReader client (specifically [Current](https://currentapp.app)) can sync against it.

## Information flow

```
                         ┌─────────────────────────────────────────────────────┐
                         │               Cloudflare Workers                     │
                         │                                                       │
  Current / any    ──────┤  /api/greader.php/*   GReader API (Hono)            │
  GReader client         │   auth: API token ──► D1 api_tokens table           │
  (FreshRSS mode)  ◄─────┤   stream/contents  ◄── D1 items + item_state        │
                         │   edit-tag (read)  ──► D1 item_state.read_at        │
                         │                                                       │
  Browser (you)    ──────┤  /app/*   Management UI (Hono + htmx + Tailwind)    │
                         │   auth: Cloudflare Access JWT                        │
  Cloudflare Access      │   /app/tokens  — generate / revoke API tokens       │
  (SSO / email OTP) ─────┤   /app/metrics — dashboard (see below)              │
                         │                                                       │
                         │  Cron  */30 * * * *  ──► FeedPollingWorkflow        │
                         │    step: get-due-feeds   ◄── D1 feeds               │
  RSS / Atom feeds        │    step: fetch-batch-N   ──► fetch(feedUrl)         │
  (internet)       ◄─────┤      parse XML           ──► D1 items (upsert)      │
                         │      update intervals     ──► D1 feeds               │
                         │    step: record-cycle     ──► D1 cycle_runs          │
                         │                           ──► Pipeline (metrics)     │
                         │                                                       │
                         │  Cron  0 3 * * 1  ──► purgeOldItems                 │
                         │    DELETE items older than ITEM_RETENTION_DAYS       │
                         └──────────────────────┬────────────────────────────┬──┘
                                                │                            │
                                    ┌───────────▼────────┐    ┌─────────────▼──────────┐
                                    │   Cloudflare D1    │    │  Cloudflare Pipeline   │
                                    │   (SQLite)         │    │  → R2 rss-reader-      │
                                    │                    │    │    metrics-store       │
                                    │  feeds             │    │  → Iceberg/Parquet     │
                                    │  subscriptions     │    │                        │
                                    │  items             │    │  Queryable via         │
                                    │  item_state        │    │  R2 SQL API            │
                                    │  cycle_runs        │    │                        │
                                    │  api_tokens        │    │  Metrics:              │
                                    └────────┬───────────┘    │  feed_parse_duration   │
                                             │                │  feed_new_articles     │
                                             │                │  feed_fetch_error      │
                                    ┌────────▼───────────┐    │  article_read          │
                                    │  /app/metrics      │    │  cycle_*               │
                                    │  Metrics dashboard │◄───┤  subscription_change   │
                                    │                    │    └────────────────────────┘
                                    │  D1-backed (real-  │
                                    │  time, always on): │
                                    │  · cycle timeline  │
                                    │  · feed health     │
                                    │  · reads per day   │
                                    │  · feed activity   │
                                    │  · poll intervals  │
                                    │                    │
                                    │  R2 SQL (30-day,   │
                                    │  when configured): │
                                    │  · article trend   │
                                    │  · feed velocity   │
                                    │  · fetch perf      │
                                    │  · error rates     │
                                    └────────────────────┘
```

## Stack

- **Runtime**: Cloudflare Workers + D1 (SQLite) + Workflows + static assets
- **Router**: Hono with JSX server-rendering
- **UI**: htmx (vendored) + Tailwind CSS v4 — no React
- **Feed parsing**: rss-parser
- **Auth**: Cloudflare Access (management UI) + SHA-256 API tokens (GReader clients)
- **Schema / migrations**: Drizzle ORM
- **Observability**: `@workers-powertools/logger` (structured JSON logs + correlation IDs), `@workers-powertools/tracer` (per-feed spans), `@workers-powertools/metrics` → Cloudflare Pipelines → R2/Iceberg (long-term analytics)

## Connecting Current and other RSS readers

In Current: **Settings → Sync → FreshRSS**

```
Server URL:  https://<your-worker-domain>
Username:    <your email>
Password:    <API token generated from /app/tokens>
```

Current treats this Worker as a FreshRSS instance. It speaks the standard GReader protocol — no FreshRSS installation required.

## Feed polling

Feeds are fetched via a **Cloudflare Workflow** triggered every 30 minutes. Each run:

1. Queries all feeds whose `check_interval_minutes` has elapsed (stale-first ordering)
2. Processes them in sequential batches of 20, fetching each batch concurrently
3. Writes a `cycle_runs` row to D1 for the Metrics dashboard
4. Emits batched metric events to a Cloudflare Pipeline for long-term analytics

**Why Workflows instead of a plain cron handler?** The free plan limits each Worker invocation to 50 subrequests. Each feed fetch costs ~2 (1 HTTP GET + 1 D1 batch write). Sequential Workflow steps each run in a fresh invocation with a fresh budget, so there is no cap on total feed count.

**Adaptive backoff** — `check_interval_minutes` per feed, default 30 min:

| Event | Interval change |
|---|---|
| New articles found | Reset to 30 min (or feed's `<ttl>` if longer, up to 24 h) |
| No new content / HTTP 304 | Double, capped at 4 hours |
| HTTP 429 rate limit | Double (or `Retry-After`), capped at 4 hours; no error count increment |
| Any other HTTP error / parse error | No change to interval; consecutive error count incremented |
| 5 consecutive errors | Feed deactivated — stops being polled |

**Article retention** — a weekly cron (Mondays 03:00 UTC) deletes articles older than `ITEM_RETENTION_DAYS` (default: 30 days).

## Metrics dashboard (`/app/metrics`)

The dashboard has two data layers:

**D1-backed (always available, near-real-time):**
- KPI cards: total articles, new this week, reads (7d), last cycle
- Polling cycle timeline — bar chart of last 48 runs (~24 h at 30-min intervals)
- Feed activity — top publishers by new articles in the last 7 days
- Feed health — erroring / rate-limited / deactivated feeds with last error and timestamps
- Poll interval distribution — how backed-off the fleet currently is
- Reads by day — 7-day bar chart from `item_state.read_at`

**R2 SQL analytics (requires `R2_SQL_AUTH_TOKEN` secret, toggled by `ANALYTICS_ENABLED`):**
- 30-day new articles trend — daily bar chart from pipeline data
- Feed velocity — top publishers over 30 days with avg articles per fetch
- Fetch performance — slowest feeds by avg/max parse duration (7d)
- Error rates by HTTP status code (7d)

Set `ANALYTICS_ENABLED=false` in `wrangler.jsonc` to disable all Pipeline metric writes and R2 SQL queries.

## One-time setup

```bash
# 1. Create the D1 database — copy the returned database_id into wrangler.jsonc
pnpm wrangler d1 create rss-reader

# 2. Apply schema migrations
pnpm wrangler d1 migrations apply rss-reader --local   # local dev
pnpm wrangler d1 migrations apply rss-reader --remote  # production

# 3. Set required secrets
#    To find CF_ACCESS_AUD: Zero Trust → Access → Applications → your management UI app
#    → Settings → scroll to "Application Audience (AUD) Tag" — a 64-char hex string
wrangler secret put CF_ACCESS_AUD   # Cloudflare Access audience tag (JWT verification)

# 4. Create an R2 bucket and enable the Data Catalog (required for R2 SQL)
pnpm wrangler r2 bucket create rss-reader-metrics-store
pnpm wrangler r2 bucket catalog enable rss-reader-metrics-store

# 5a. Create the pipeline stream (the Worker binding writes to this)
#     pipeline-schema.json defines column types for each metric field
pnpm wrangler pipelines streams create rss_reader_metrics_stream \
  --schema-file pipeline-schema.json

# 5b. Create the R2 Data Catalog sink (Iceberg tables, queryable via R2 SQL)
#     Retrieve your catalog token: wrangler r2 bucket catalog get rss-reader-metrics-store
pnpm wrangler pipelines sinks create rss_reader_metrics_sink \
  --type r2-data-catalog \
  --bucket rss-reader-metrics-store \
  --namespace rss_reader \
  --table metrics \
  --catalog-token <your-r2-sql-auth-token> \
  --roll-interval 300

# 5c. Create the pipeline connecting stream to sink
#     The pipeline name must match the "pipeline" value in wrangler.jsonc
pnpm wrangler pipelines create rss_reader_metrics \
  --sql 'INSERT INTO rss_reader_metrics_sink SELECT * FROM rss_reader_metrics_stream'

# 6. Set R2 SQL auth token for dashboard analytics (optional but recommended)
#    Create at: Cloudflare dashboard → R2 → Manage R2 API Tokens
#    Permissions required: R2 Storage Read + Data Catalog Read + R2 SQL Read
wrangler secret put R2_SQL_AUTH_TOKEN
```

Set `DISPLAY_TIMEZONE` in `wrangler.jsonc` to your local [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `America/Chicago`) so the reads-per-day chart groups by the correct local day.

**Cloudflare Access setup:**

Access must protect the management UI while allowing GReader clients to reach the API without a browser session. Use two overlapping Access applications on the same subdomain — Access evaluates the most-specific path first.

**App 1 — GReader API bypass** (create this first)

1. Zero Trust → Access → Applications → Add → **Self-hosted**
2. Domain: `myreader.example.com`, path: `/api/greader.php/*`
3. Policy: **Action = Bypass**, Include = **Everyone**
   > Action must be Bypass — Allow still redirects API calls to the login page

**App 2 — Management UI** (catch-all)

1. Add another Self-hosted application
2. Domain: `myreader.example.com` (no path — catches everything else)
3. Policy: **Action = Allow**, Include = **Emails** → your email address
4. Copy the **Audience Tag** → `wrangler secret put CF_ACCESS_AUD`

Also add a custom domain to the Worker in the Cloudflare dashboard and point both Access applications at it.

## Local development

```bash
pnpm install

# Copy and fill in local secrets
cp .dev.vars.sample .dev.vars
# Set DEV_MODE=true to bypass Cloudflare Access JWT verification locally

pnpm dev        # compile CSS then start wrangler dev
pnpm test       # run vitest suite
```

For CSS hot-reload during UI development, run `pnpm dev:css` in a separate terminal.

## Deployment

```bash
pnpm deploy     # compile CSS + wrangler deploy
```

## Scripts

| Script            | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `pnpm dev`        | Compile CSS, start local Worker dev server                       |
| `pnpm dev:css`    | Watch mode CSS compilation                                       |
| `pnpm build`      | Compile CSS + production Worker build (no deploy)                |
| `pnpm deploy`     | Build + deploy to Cloudflare                                     |
| `pnpm test`       | Run vitest suite                                                 |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` from wrangler config      |
| `pnpm studio`     | Open Drizzle Studio against local D1 (run `wrangler dev` first)  |
| `pnpm format`     | Format all TypeScript source files with Prettier                 |

## Env vars and secrets

| Name | Type | Description |
|---|---|---|
| `CF_ACCESS_AUD` | secret | Cloudflare Access audience tag for JWT verification |
| `R2_SQL_AUTH_TOKEN` | secret | R2 API token for querying pipeline analytics via R2 SQL |
| `CF_ACCOUNT_ID` | var | Cloudflare account ID (used by R2 SQL queries) |
| `DISPLAY_TIMEZONE` | var | IANA timezone for dashboard date grouping (default: UTC) |
| `ITEM_RETENTION_DAYS` | var | Days to retain articles before weekly cleanup (default: 30) |
| `ANALYTICS_ENABLED` | var | Set to `"false"` to disable all Pipeline writes and R2 SQL queries |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — project structure, D1 schema, cron jobs
- [`docs/auth-flow.md`](docs/auth-flow.md) — Cloudflare Access + API token lifecycle
- [`docs/greader-api.md`](docs/greader-api.md) — GReader endpoint reference
- [`docs/decisions.md`](docs/decisions.md) — rationale behind key technical choices
