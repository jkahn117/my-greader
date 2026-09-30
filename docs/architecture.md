# Architecture

This document describes the current implementation. The [target architecture for next](next-architecture.md) records the directory layout and module ownership for the migration in [issue #18](https://github.com/jkahn117/my-greader/issues/18).

## Stack

Single Cloudflare Worker (Hono + JSX) backed by D1 (SQLite) and Workers
Analytics Engine for metrics.  Feed polling runs inside a Cloudflare Workflow
to stay within the free-tier subrequest budget.  The management UI uses htmx
for interactivity without a client bundle.

## Deep modules (`src/feed/`)

Feed-level business logic lives in five modules, each behind a small factory
interface. Handlers and the Workflow are thin adapters that parse protocol
concerns and delegate.

| Module | Responsibility | Observer? |
|--------|---------------|-----------|
| `poll.ts` | Fetch, parse, store items; interval backoff; error tracking and deactivation | `PollObserver` — Powertools stays in the Workflow |
| `subscriptions.ts` | Canonical feed upsert; subscribe, unsubscribe, edit; list and get | `SubObserver` — Powertools stays in handlers |
| `item-state.ts` | Per-User read/star transitions, read timestamps, ownership checks, and scoped mark-all updates | None — domain persistence module |
| `stream.ts` | User-scoped Stream resolution and paginated Item queries; query predicates stay private | None — pure query module |
| `analytics.ts` | Analytics Engine SQL queries, physical column layout, row mapping, degradation | None — read adapter |

These modules accept D1 directly because there is one store implementation.
`item-state.ts` and `stream.ts` share a small Stream scope value, while the
GReader adapter owns parsing protocol Stream IDs into that value.

Observability tools (`@workers-powertools`) never cross the module seams.
Observer interfaces carry domain event payloads; the caller wires them to
the concrete logger and metrics implementations.

## Data model

- **Shared:** `feeds` (canonical), `items` (article content, trimmed to 50KB)
- **Per-user:** `subscriptions`, `item_state` (read/starred), `api_tokens`
- **Operational:** `cycle_runs` (stable Workflow identity, trigger, lifecycle, and counts), `feed_poll_attempts` (logical per-Feed attempt timing, outcome, and committed Item count)

New Items store a nullable `first_ingestion_attempt_id`. The polling insert sets it once, and conflict handling never replaces it when a later attempt sees the same Item. Items that predate migration `0006_poll_traceability.sql` retain `NULL`; the application does not infer attribution from `fetched_at`.

See the D1 Drizzle schema in `src/db/schema.ts` for column details.

## Request routing

- `/reader/*` and `/accounts/ClientLogin` — GReader-compatible API, token auth
- `/app/*`, `/tokens/*`, `/import` — Management UI, Cloudflare Access JWT auth

The GReader API follows the FreshRSS dialect of the Google Reader protocol.
See [`docs/greader-api.md`](greader-api.md) for endpoint details.

## Feed polling

Triggered every 30 minutes.  The cron handler starts a `FeedPollingWorkflow`
which queries due Feeds and processes them in batches of 8. Each Feed uses a
small fixed number of HTTP or D1 binding calls: progress check, HTTP, atomic
completion, and committed-result read. The smaller batch stays under the
50-subrequest invocation budget.

Per-feed logic is owned by the `FeedPoller` module.  The Workflow provides
a narrow `FeedTransport` (global `fetch` with 15s timeout) and a `PollObserver`
that maps domain events to logger, metrics, and wide events.  The module
handles conditional requests (ETag/Last-Modified), rate limiting (429 with
Retry-After), two-tier error deactivation (2 strikes for permanent errors
like 404/410, 5 for transient), lenient fallback parsing, and adaptive
interval backoff (30 → 240 minutes).

The Workflow instance ID is the Cycle Run ID. A logical attempt ID combines that stable instance ID with the Feed ID. Runtime retries do not get new attempt IDs, so every retry addresses the same record. The Workflow always creates a Cycle Run, including a completed `empty` run when no active subscribed Feed is eligible. `FeedPoller` creates an in-progress attempt before HTTP work and commits one of `new_items`, `unchanged`, `not_modified`, `rate_limited`, or `failed`. A retry returns an existing terminal attempt without repeating HTTP. Failed attempts use stable `network`, `http`, or `parse` classifications and store diagnostics redacted and capped at 500 characters. A null attempt outcome or a running Cycle Run means work did not complete.

Before HTTP work, every scheduled, normal manual, and forced attempt must acquire the Feed's five-minute ownership lease. Acquisition increments a per-Feed fencing number. Every completion verifies the attempt ID, fencing number, and unexpired lease in the same D1 batch as its writes. A competing Cycle Run records a skipped attempt without making an HTTP request. An unfinished attempt can renew its lease. Reacquisition after expiry increments the fence so its earlier runtime cannot commit. A different attempt can take an expired lease, and the superseded attempt cannot reacquire or change Feed state.

D1 `batch()` is the attempt completion boundary. Item insertion, first-attempt attribution, Feed health and backoff changes, and the terminal attempt outcome commit in one transaction. D1 rolls back the whole batch if any statement fails. Successful ingestion uses SQLite JSON table expansion so many Items fit into a few statements instead of one query per Item. JSON parameters are chunked below 1.5 MB, under D1's 2 MB value limit; the behavior suite exercises a 250-Item Feed. Every mutation checks that the attempt is still running, and the terminal attempt update is last. A failure before commit leaves no successful effects. If D1 commits but the Worker loses the acknowledgment, the next retry reads the terminal outcome.

Cycle Run summaries derive from durable attempts. `active_feeds` and `selected_feeds` count distinct Feeds, not Subscription rows. `checked_feeds` counts terminal attempts except `skipped`; `failed_feeds` counts the `failed` subset; `skipped_feeds` counts selected Feeds deliberately not checked; and `new_items` sums committed attempt counts. Completion only updates a running Cycle Run, so replay cannot rewrite its durable summary. Forced runs bypass due time but still exclude deactivated and unsubscribed Feeds.

## Metrics

**Writes:** `createMetrics()` in `src/lib/metrics.ts` uses
`AnalyticsEngineBackend` to write fire-and-forget data points to Workers
Analytics Engine.

**Reads:** `createAnalyticsReader()` in `src/feed/analytics.ts` owns the
AE SQL dialect and `blob`/`double`/`index` column layout, runs four
aggregate queries in parallel, and returns typed domain projections.
The dashboard handler never sees raw AE rows.

**Real-time dashboard cards** (cycle timeline, feed health, reads per day)
query D1 directly and work without analytics. The Timeline follows Item-to-attempt-to-Cycle-Run foreign keys and filters Items through the authenticated User's Subscriptions. Legacy Cycle Runs and Items are marked as unattributed; timestamp windows are not used.

## Auth

See [`docs/auth-flow.md`](auth-flow.md).

## Wrangler configuration

One Worker, one D1 database, one Analytics Engine dataset, one Workflow.
Two cron triggers.  Secrets: `CF_ACCESS_AUD`, `CF_API_TOKEN`, `DEV_MODE`.
Vars: `ITEM_RETENTION_DAYS`, `CF_ACCOUNT_ID`, `DISPLAY_TIMEZONE`, `ANALYTICS_ENABLED`.
