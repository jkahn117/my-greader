# Architecture

## Stack

Single Cloudflare Worker (Hono + JSX) backed by D1 (SQLite) and Workers
Analytics Engine for metrics.  Feed polling runs inside a Cloudflare Workflow
to stay within the free-tier subrequest budget.  The management UI uses htmx
for interactivity without a client bundle.

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

These modules accept D1 directly (no repository adapter) because there is only
one store implementation.

Observability tools (`@workers-powertools`) never cross the module seams.
Observer interfaces carry domain event payloads; the caller wires them to
the concrete logger and metrics implementations.

## Data model

- **Shared:** `feeds` (canonical), `items` (article content, trimmed to 50KB)
- **Per-user:** `subscriptions`, `item_state` (read/starred), `api_tokens`
- **Operational:** `cycle_runs` (polling cycle summary)

See the D1 Drizzle schema in `src/db/schema.ts` for column details.

## Request routing

- `/reader/*` and `/accounts/ClientLogin` — GReader-compatible API, token auth
- `/app/*`, `/tokens/*`, `/import` — Management UI, Cloudflare Access JWT auth

The GReader API follows the FreshRSS dialect of the Google Reader protocol.
See [`docs/greader-api.md`](greader-api.md) for endpoint details.

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

## Auth

See [`docs/auth-flow.md`](auth-flow.md).

## Wrangler configuration

One Worker, one D1 database, one Analytics Engine dataset, one Workflow.
Two cron triggers.  Secrets: `CF_ACCESS_AUD`, `CF_API_TOKEN`, `DEV_MODE`.
Vars: `ITEM_RETENTION_DAYS`, `CF_ACCOUNT_ID`, `DISPLAY_TIMEZONE`, `ANALYTICS_ENABLED`.
