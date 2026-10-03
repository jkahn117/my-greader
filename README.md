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
  Cloudflare Access      │   /app/access  — generate / revoke API tokens       │
  (SSO / email OTP) ─────┤   /app/metrics — dashboard (see below)              │
                         │                                                       │
                         │  Cron  */30 * * * *  ──► FeedPollingWorkflow        │
                         │    step: get-due-feeds   ◄── D1 feeds               │
  RSS / Atom feeds        │    step: fetch-batch-N   ──► fetch(feedUrl)         │
  (internet)       ◄─────┤      parse XML           ──► D1 items (upsert)      │
                         │      update intervals     ──► D1 feeds               │
                         │    stable Workflow ID    ──► D1 cycle_runs          │
                         │    per-Feed attempt       ──► D1 feed_poll_attempts  │
                         │    first ingestion       ──► D1 Item attribution    │
                         │                           ──► Analytics Engine      │
                         │                                                       │
                         │  Cron  0 3 * * 1  ──► bounded retention             │
                         │    purge unstarred old Items + 90-day poll history   │
                         └──────────────────────┬────────────────────────────┬──┘
                                                │                            │
                                    ┌───────────▼────────┐    ┌─────────────▼──────────┐
                                    │   Cloudflare D1    │    │  Analytics Engine      │
                                    │   (SQLite)         │    │  optional trends       │
                                    │                    │    │                        │
                                    │  feeds             │    │  feed_parse_duration_ms│
                                    │  subscriptions     │    │  feed_new_articles     │
                                    │  items             │    │  feed_fetch_error      │
                                    │  item_state        │    │  article_read          │
                                    │  cycle_runs        │    │  cycle_*               │
                                    │  feed_poll_attempts│    │  subscription_change   │
                                    │  api_tokens        │    └────────────┬───────────┘
                                    └────────┬───────────┘                 │
                                             │                             │
                                    ┌────────▼─────────────────────────────▼──┐
                                    │  /app/metrics and /app/timeline         │
                                    │                                         │
                                    │  D1: durable history and current state  │
                                    │  AE: optional aggregate trends          │
                                    └─────────────────────────────────────────┘
```

## Stack

- **Runtime**: Cloudflare Workers + D1 (SQLite) + Workflows + static assets
- **Router**: Hono with JSX server-rendering
- **UI**: htmx (vendored) + Tailwind CSS v4 — no React
- **Feed parsing**: rss-parser
- **Auth**: Cloudflare Access (management UI) + SHA-256 API tokens (GReader clients)
- **Schema / migrations**: Drizzle ORM
- **Observability**: `@workers-powertools/logger` for structured logs and correlation IDs, `@workers-powertools/tracer` for per-Feed spans, and `@workers-powertools/metrics` with Workers Analytics Engine for optional trends

## Connecting Current and other RSS readers

In Current: **Settings → Sync → FreshRSS**

```
Server URL:  https://<your-worker-domain>
Username:    <your email>
Password:    <API token generated from /app/access>
```

Current treats this Worker as a FreshRSS instance. It speaks the standard GReader protocol — no FreshRSS installation required.

## Feed polling

Feeds are fetched via a **Cloudflare Workflow** triggered every 30 minutes. Each run:

1. Queries active subscribed Feeds whose explicit `next_poll_at` has elapsed (earliest eligible first)
2. Processes them in sequential batches of 8, fetching each batch concurrently
3. Creates a `cycle_runs` row keyed by the stable Workflow instance ID, even when no Feed is eligible
4. Records in-progress logical Feed attempts before HTTP work, then commits distinct unchanged, not-modified, rate-limited, or classified failure outcomes
5. Records successful checks, precise new-Item discovery, initial backload completion, next eligibility, and Deactivation reason separately
6. Derives the Cycle Run summary from durable attempts and emits batched metrics

**Why Workflows instead of a plain cron handler?** The free plan limits each Worker invocation to 50 subrequests. Each Feed uses a small fixed number of HTTP or D1 binding calls for durable progress, fetching, atomic completion, and committed-result reads. Sequential Workflow steps each run in a fresh invocation with a fresh budget, so the total Feed count is not capped by one invocation.

**Adaptive backoff** — `check_interval_minutes` per feed, default 30 min:

| Event | Interval change |
|---|---|
| New articles found | Reset to 30 min (or feed's `<ttl>` if longer, up to 24 h) |
| No new content | Double, capped at 4 hours, or honor a longer Feed `<ttl>` up to 24 hours |
| HTTP 304 | Double, capped at 4 hours |
| HTTP 429 rate limit | At least double, while honoring a longer `Retry-After`; no error count increment |
| Any other HTTP error / parse error | No change to interval; consecutive error count incremented |
| 5 transient errors or 2 permanent errors | Feed deactivated with the reason recorded; stops being polled |

**Item and polling-history retention** — a weekly cron (Mondays 03:00 UTC) deletes Items older than `ITEM_RETENTION_DAYS` (default: 30 days) only when no User has starred them. Starred Items and all of their Item State remain. Cycle Runs and Feed attempts expire after 90 days; retained Items then become explicitly unattributed rather than keeping dangling references or guessed history. Cleanup is bounded to five batches of 500 Items and five batches of 100 Cycle Runs per invocation.

## Metrics dashboard (`/app/metrics`)

The dashboard has two data layers:

**D1-backed (always available, near-real-time):**
- KPI cards: total articles, new this week, reads (7d), last cycle
- Polling cycle timeline — bar chart of the last 48 scheduled or manual runs
- Feed activity — top publishers by new articles in the last 7 days
- Poll interval distribution — how backed-off the fleet currently is
- Reads by day — 7-day bar chart from `item_state.read_at`

**Analytics Engine trends (requires `CF_API_TOKEN` with Account Analytics Read, toggled by `ANALYTICS_ENABLED`):**
- 30-day new Items trend
- Feed velocity — top publishers over 30 days with avg articles per fetch
- Fetch performance — slowest feeds by avg/max parse duration (7d)
- Error rates by HTTP status code (7d)

Set `ANALYTICS_ENABLED=false` in `wrangler.jsonc` to disable Analytics Engine writes and dashboard queries. Durable D1 history remains available.

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
pnpm wrangler secret put CF_ACCESS_AUD   # Cloudflare Access audience tag (JWT verification)
pnpm wrangler secret put CF_ACCESS_ISSUER # Exact team origin: https://<team>.cloudflareaccess.com

# 4. Set the optional Analytics Engine read credential used by the dashboard.
#    The token needs Account Analytics Read permission. Metric writes use the
#    ANALYTICS binding and do not use this token.
pnpm wrangler secret put CF_API_TOKEN
```

`wrangler.jsonc` declares both Access secrets in `secrets.required` for generated binding types and local missing-secret warnings. `CF_API_TOKEN` remains optional.

Set `DISPLAY_TIMEZONE` in `wrangler.jsonc` to your local [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `America/Chicago`) for dashboard timestamp display. D1's reads-per-day aggregation uses UTC day boundaries.

**Cloudflare Access setup:**

Access must protect the management UI while allowing GReader clients to reach the API without a browser session. Use two overlapping Access applications on the same subdomain — Access evaluates the most-specific path first. The configuration below covers Current's `/api/greader.php/*` requests. If another client uses the supported bare routes, add equivalent bypass applications for `/reader/*` and `/accounts/ClientLogin`.

**App 1 — GReader API bypass** (create this first)

1. Zero Trust → Access → Applications → Add → **Self-hosted**
2. Domain: `myreader.example.com`, path: `/api/greader.php/*`
3. Policy: **Action = Bypass**, Include = **Everyone**
   > Action must be Bypass — Allow still redirects API calls to the login page

**App 2 — Management UI** (catch-all)

1. Add another Self-hosted application
2. Domain: `myreader.example.com` (no path — catches everything else)
3. Policy: **Action = Allow**, Include = **Emails** → your email address
4. Copy the **Audience Tag** → `pnpm wrangler secret put CF_ACCESS_AUD`
5. Set `CF_ACCESS_ISSUER` to your HTTPS team origin, `https://<team>.cloudflareaccess.com`, with no trailing slash. Find the team name in Cloudflare One settings. Existing deployments must set this before deploying the updated Worker; authenticated requests return `500 Authentication unavailable` without it.

Also add a custom domain to the Worker in the Cloudflare dashboard and point both Access applications at it.

## Local development

```bash
pnpm install

# Copy and fill in local secrets
cp .dev.vars.sample .dev.vars
# Set DEV_MODE=true to bypass Cloudflare Access JWT verification locally

pnpm dev        # compile CSS then start wrangler dev
pnpm test       # run development-auth and production-auth test modes
```

For CSS hot-reload during UI development, run `pnpm dev:css` in a separate terminal.

### Reproducing pull request checks

Pull requests targeting `next` run the following credential-free checks. Run the same commands from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

`pnpm check` runs the last four commands after dependencies are installed. The test suite uses workerd, local D1 databases, and every migration in `drizzle/`. `vitest.config.ts` keeps the existing development-auth bypass. `vitest.production.config.ts` disables that bypass and supplies a synthetic Access audience and issuer for production-auth tests. Both configurations override test variables with checked-in synthetic values and disable remote bindings, so `.dev.vars`, Cloudflare credentials, remote D1, and live Analytics Engine data cannot affect test behavior. Tests simulate outbound services such as Feed servers and Access JWKS when those boundaries are exercised. `test/access.production.test.ts` signs local RSA assertions and sends them through `/app/access`, exercising real Web Crypto, middleware, and migrated D1. It covers malformed assertions, identity provisioning, rejection without provisioning, expiry boundaries, issuer-scoped JWKS reuse, expiration, and unknown-key refresh. Independent cases reload Worker modules to isolate the private key cache; cache-policy cases preserve modules and control time. Run it alone with `pnpm exec vitest run --config vitest.production.config.ts test/access.production.test.ts`.

## Deployment

Before deploying this cutover, follow the [migration and recovery runbook](docs/migration-baseline.md). It covers the verified export, migrations `0006` through `0009`, old Workflow drainage, canaries, Current synchronization, and rollback or forward recovery.

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
| `pnpm test`       | Run development-auth and isolated production-auth test modes     |
| `pnpm typecheck`  | Run the verified strict TypeScript check without emitting files  |
| `pnpm check`      | Run lint, both test modes, type-checking, and the production build |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` from wrangler config      |
| `pnpm studio`     | Open Drizzle Studio against local D1 (run `wrangler dev` first)  |
| `pnpm format`     | Format TypeScript source files with Oxfmt                        |
| `pnpm format:check` | Check TypeScript source formatting                             |
| `pnpm lint`       | Lint TypeScript source files with Oxlint                        |

## Env vars and secrets

| Name | Type | Description |
|---|---|---|
| `CF_ACCESS_AUD` | secret | Cloudflare Access audience tag for JWT verification |
| `CF_ACCESS_ISSUER` | secret | Exact HTTPS Access team origin, without a trailing slash |
| `CF_API_TOKEN` | secret | Cloudflare API token with Account Analytics Read for optional Analytics Engine dashboard queries |
| `CF_ACCOUNT_ID` | var | Cloudflare account ID used by Analytics Engine SQL queries |
| `DISPLAY_TIMEZONE` | var | IANA timezone for dashboard timestamp display (default: UTC); reads-per-day uses UTC boundaries |
| `ITEM_RETENTION_DAYS` | var | Days to retain articles before weekly cleanup (default: 30) |
| `ANALYTICS_ENABLED` | var | Set to `"false"` to disable Analytics Engine writes and queries |
| `DEV_MODE` | local only | Set to `"true"` in `.dev.vars` to use the local development identity; never set in production |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — project structure, D1 schema, cron jobs
- [`docs/auth-flow.md`](docs/auth-flow.md) — Cloudflare Access + API token lifecycle
- [`docs/greader-api.md`](docs/greader-api.md) — GReader endpoint reference
- [`docs/migration-baseline.md`](docs/migration-baseline.md) — compatibility checks and migration recovery
- [`docs/decisions.md`](docs/decisions.md) — rationale behind key technical choices
