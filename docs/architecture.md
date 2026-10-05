# Architecture

## Stack

Single Cloudflare Worker (Hono) backed by D1 (SQLite) and Workers
Analytics Engine for metrics.  Feed polling runs inside a Cloudflare Workflow
to stay within the free-tier subrequest budget.  The management UI is a React
single-page client (Vite + TanStack Router + shadcn components) served from
the same Worker's assets, calling a same-origin JSON API under `/app/api/*`.
(The earlier htmx server-rendered UI was removed in issue #50.)

## Deep modules (`src/feed/`)

Feed-level business logic lives in four modules, each behind a small factory
interface.  Handlers and the Workflow become thin adapters that parse
protocol concerns and delegate.

| Module | Responsibility | Observer? |
|--------|---------------|-----------|
| `poll.ts` | Fetch, parse, store items; interval backoff; error tracking and deactivation | `PollObserver` — Powertools stays in the Workflow |
| `subscriptions.ts` | Canonical feed upsert; subscribe, unsubscribe, edit; list and get | `SubObserver` — Powertools stays in handlers |
| `stream.ts` | GReader stream scope resolution, paginated item queries, feed-ID lookup | None — pure query module |
| `analytics.ts` | Analytics Engine SQL queries, physical column layout, row mapping, degradation | None — read adapter |
| `activity.ts` | Bounded dashboard projections (overview totals, subscription workspace rows) scoped to the authenticated user | None — read model |
| `eligibility.ts` | Due-feed selection shared by the polling Workflow and manual sync (`force` drops due time only) | None — read model |
| `history.ts` | Per-feed attempt evidence: cursor pagination, terminal-check streaks, problem grouping, attributed items | None — read model |
| `reading.ts` | Marked-read metrics (daily in the display timezone, per-Feed) scoped to current Subscriptions | None — read model |

These modules accept D1 directly (no repository adapter) because there is only
one store implementation.

Observability tools (`@workers-powertools`) never cross the module seams.
Observer interfaces carry domain event payloads; the caller wires them to
the concrete logger and metrics implementations.

## Data model

- **Shared:** `feeds` (canonical), `items` (article content, trimmed to 50KB)
- **Per-user:** `subscriptions`, `item_state` (read/starred), `api_tokens`
- **Operational:** `cycle_runs` (polling cycle summary), `feed_attempts` (per-check evidence, ~90-day retention)

`feeds` carries check-state columns (`last_fetched_at`,
`last_successful_at`, `last_status`, `check_interval_minutes`,
`consecutive_errors`, `last_error`, `deactivated_at`,
`deactivated_reason`) so the dashboard can present health, eligibility,
and deactivation facts without reconstructing them from item timestamps.

`feed_attempts` records one row per check attempt (in-progress at start,
finalized with status/httpStatus/errorKind/parserState/itemsAdded on
completion). Items link back via `items.attempt_id` — attribution is the
durable attempt reference, never timestamp reconstruction. `cycle_run_id`
is the polling workflow's instance id. The workflow purges attempts older
than ~90 days at the end of each cycle.

See the D1 Drizzle schema in `src/db/schema.ts` for column details.

## Request routing

- `/reader/*` and `/accounts/ClientLogin` — GReader-compatible API, token auth
- `/app/api/*` — Dashboard JSON API for the React client, Cloudflare Access JWT
- `/app/*` (other paths) — Static assets; `not_found_handling:
  single-page-application` serves `index.html` so TanStack Router routes
  deep-link.  `assets.run_worker_first` in `wrangler.jsonc` keeps the
  `/app/api/*` JSON endpoints and GReader routes on the Worker.

The GReader API follows the FreshRSS dialect of the Google Reader protocol.
See [`docs/greader-api.md`](greader-api.md) for endpoint details.

## Management client

`src/client/` holds the React SPA (`main.tsx` entry from `index.html`,
TanStack Router routes under basepath `/app`, shadcn components in
`components/ui/`).  It consumes `/app/api/*` via plain `fetch` in route
loaders; response types are shared in `src/shared/dashboard-api.ts`.
Access (`/app/access`) uses `/app/api/tokens` (`src/handlers/tokens_api.ts`);
the token lifecycle (hashing, one-time raw value, User-scoped revocation,
hourly last-used resolution) lives in `src/lib/api-tokens.ts` and is shared
with `tokenMiddleware`.
`vite build` emits the client to `dist/client` (the wrangler `assets`
directory) and the Worker to `dist/my_greader`.  Per-file
`@jsxImportSource react` pragmas keep `tsc` honest while the server side
stays on `hono/jsx`.

Browser acceptance tests live in `e2e/` (Playwright, `pnpm test:browser`)
and run against `pnpm dev`.

## Feed polling

Triggered every 30 minutes.  The cron handler starts a `FeedPollingWorkflow`
which queries due feeds and processes them in batches of 20 (each batch
consumes ~40 subrequests, staying under the 50-per-invocation budget).

Per-feed logic is owned by the `FeedPoller` module.  The Workflow provides
a narrow `FeedTransport` (global `fetch` with 15s timeout) and a `PollObserver`
that maps domain events to logger, metrics, and wide events.  The module
handles conditional requests (ETag/Last-Modified), rate limiting (429 with
Retry-After), two-tier error deactivation (2 strikes for permanent errors
like 404/410, 5 for transient), lenient fallback parsing, and adaptive
interval backoff (30 → 240 minutes).

## Metrics

**Writes:** `createMetrics()` in `src/lib/metrics.ts` uses
`AnalyticsEngineBackend` to write fire-and-forget data points to Workers
Analytics Engine.

**Reads:** `createAnalyticsReader()` in `src/feed/analytics.ts` owns the
AE SQL dialect and `blob`/`double`/`index` column layout, runs four
aggregate queries in parallel, and returns typed domain projections.
The dashboard handler never sees raw AE rows.

**Real-time dashboard cards** (cycle timeline, feed health, reads per day)
query D1 directly and work without analytics.

**Reading page** (`GET /app/api/reading?days=7|14|30`, `src/feed/reading.ts`)
counts current `item_state` rows with `is_read = 1`, grouped by `read_at` —
the latest server receipt of a mark-read.  `edit-tag` and
`mark-all-as-read` stamp `read_at` on every mark-read (re-reads replace
it) and `edit-tag` clears it on unread, so there is no read history: only
current state with its latest receipt time.  Scope is the user's current
Subscriptions (deactivated Feeds included, unsubscribed Feeds excluded).
The window is whole calendar days in `DISPLAY_TIMEZONE` (invalid values
fall back to UTC) ending with today as a partial day; boundaries are
computed in the Worker and passed to SQLite as one `json_each` parameter,
and missing days are zero-filled.  Starred count is a current-state
supporting metric, not windowed.  Item retention purges unstarred items and
their state, so older receipts can disappear.

## Auth

See [`docs/auth-flow.md`](auth-flow.md).

## Wrangler configuration

One Worker, one D1 database, one Analytics Engine dataset, one Workflow.
Two cron triggers.  Secrets: `CF_ACCESS_AUD`, `CF_API_TOKEN`, `DEV_MODE`.
Vars: `ITEM_RETENTION_DAYS`, `CF_ACCOUNT_ID`, `DISPLAY_TIMEZONE`, `ANALYTICS_ENABLED`.
