# Architecture

This document describes the implementation after the migration in [issue #18](https://github.com/jkahn117/my-greader/issues/18). The [migration architecture record](next-architecture.md) now points here rather than describing a second target layout.

## Stack

Single Cloudflare Worker (Hono + JSX) backed by D1 (SQLite) and Workers
Analytics Engine for metrics.  Feed polling runs inside a Cloudflare Workflow
to stay within the free-tier subrequest budget.  The management UI uses htmx
for interactivity without a client bundle.

## Deep modules

Business logic sits behind small factory interfaces. Handlers, middleware, and
the Workflow parse protocol concerns and delegate.

| Module | Responsibility | Observer? |
|--------|---------------|-----------|
| `src/feed/poll.ts` | Feed selection, Cycle Run reconciliation, fetch and ingestion, Backoff, ownership, error tracking, and health transitions | `PollObserver`, Powertools stays in the Workflow |
| `src/feed/subscriptions.ts` | Canonical feed upsert; subscribe, unsubscribe, edit; list and get | `SubObserver`, Powertools stays in handlers |
| `src/feed/item-state.ts` | Per-User read/star transitions, read timestamps, ownership checks, and scoped mark-all updates | None, domain persistence module |
| `src/feed/stream.ts` | User-scoped Stream resolution and paginated Item queries; query predicates stay private | None, pure query module |
| `src/feed/analytics.ts` | Analytics Engine SQL queries, physical column layout, row mapping, degradation | None, read adapter |
| `src/feed/activity.ts` | Bounded Cycle Run history, User-visible attempt and Item projections, explicit unattributed history | None, read module |
| `src/feed/retention.ts` | Bounded Item and operational-history cleanup, starred Item and Item State preservation, safe attribution expiry | None, domain persistence module |
| `src/domain/tokens/` | Hash-only API Token generation, active lookup, usage recording, User-scoped revocation, listing, and revoked-token retention | None, domain persistence module |

These modules accept D1 directly because there is one store implementation.
`item-state.ts` and `stream.ts` share a small Stream scope value, while the
GReader adapter owns parsing protocol Stream IDs into that value. The API Token
module never parses headers or formats ClientLogin responses. Cloudflare Access
verification also remains outside it.

Observability tools (`@workers-powertools`) never cross the module seams.
Observer interfaces carry domain event payloads; the caller wires them to
the concrete logger and metrics implementations.

## Data model

- **Shared:** `feeds` (canonical), `items` (article content, trimmed to 50KB)
- **Per-user:** `subscriptions`, `item_state` (read/starred), `api_tokens`
- **Operational:** `cycle_runs` (stable Workflow identity, trigger, lifecycle, and counts), `feed_poll_attempts` (logical per-Feed attempt timing, outcome, and committed Item count)

New Items store a nullable `first_ingestion_attempt_id`. The polling insert sets it once, and conflict handling never replaces it when a later attempt sees the same Item. Items that predate migration `0006_poll_traceability.sql` retain `NULL`; the application does not infer attribution from `fetched_at`.

Feed polling state uses separate columns for `last_successful_poll_at`, `last_new_item_discovered_at`, `initial_backload_completed_at`, `next_poll_at`, and `deactivation_reason`. `poll_state_origin` distinguishes explicit state from inferred or uncertain legacy history. The old `last_fetched_at` and `last_new_item_at` columns remain only for rollback compatibility and receive no new reads or writes.

See the D1 Drizzle schema in `src/db/schema.ts` for column details.

## Request routing

- `/reader/*` and `/accounts/ClientLogin` — GReader-compatible API, token auth
- `/app/*`, `/tokens/*`, `/import` — Management UI, Cloudflare Access JWT auth

The GReader API follows the FreshRSS dialect of the Google Reader protocol.
See [`docs/greader-api.md`](greader-api.md) for endpoint details.

## Feed polling

Triggered every 30 minutes. The cron handler starts a `FeedPollingWorkflow`.
The Workflow asks the polling module for eligible Feeds and processes them in batches of 8. Each Feed uses a
small fixed number of HTTP or D1 binding calls: progress check, HTTP, atomic
completion, and committed-result read. The smaller batch stays under the
50-subrequest invocation budget.

Polling policy is owned by the polling module. `createPollingCycleManager()` selects eligible Feeds, starts Cycle Runs, and reconciles summaries from durable attempts. The Workflow chooses step boundaries, delegates each Feed to `FeedPoller`, and provides
a narrow `FeedTransport` (global `fetch` with 15s timeout) and a `PollObserver`
that maps domain events to logger, metrics, and wide events.  The module
handles conditional requests (ETag/Last-Modified), rate limiting (429 with
Retry-After), two-tier error deactivation (2 strikes for permanent errors
like 404/410, 5 for transient), lenient fallback parsing, and adaptive
interval backoff (30 → 240 minutes). Eligibility queries use the persisted
`next_poll_at`; forced runs bypass that timestamp but still honor Deactivation.
A successful parse completes initial backload even when the Feed is empty.
Later ingestion uses the last precise new-Item discovery, or initial completion
when no Item has been found, as the 24-hour backload anchor.

The Workflow instance ID is the Cycle Run ID. A logical attempt ID combines that stable instance ID with the Feed ID. Runtime retries do not get new attempt IDs, so every retry addresses the same record. The Workflow always creates a Cycle Run, including a completed `empty` run when no active subscribed Feed is eligible. `FeedPoller` creates an in-progress attempt before HTTP work and commits one of `new_items`, `unchanged`, `not_modified`, `rate_limited`, or `failed`. A retry returns an existing terminal attempt without repeating HTTP. Failed attempts use stable `network`, `http`, or `parse` classifications and store diagnostics redacted and capped at 500 characters. A null attempt outcome or a running Cycle Run means work did not complete.

Before HTTP work, every scheduled, normal manual, and forced attempt must acquire the Feed's five-minute ownership lease. Acquisition increments a per-Feed fencing number. Every completion verifies the attempt ID, fencing number, and unexpired lease in the same D1 batch as its writes. A competing Cycle Run records a skipped attempt without making an HTTP request. An unfinished attempt can renew its lease. Reacquisition after expiry increments the fence so its earlier runtime cannot commit. A different attempt can take an expired lease, and the superseded attempt cannot reacquire or change Feed state.

D1 `batch()` is the attempt completion boundary. Item insertion, first-attempt attribution, Feed health and backoff changes, and the terminal attempt outcome commit in one transaction. D1 rolls back the whole batch if any statement fails. Successful ingestion uses SQLite JSON table expansion so many Items fit into a few statements instead of one query per Item. JSON parameters are chunked below 1.5 MB, under D1's 2 MB value limit; the behavior suite exercises a 250-Item Feed. Every mutation checks that the attempt is still running, and the terminal attempt update is last. A failure before commit leaves no successful effects. If D1 commits but the Worker loses the acknowledgment, the next retry reads the terminal outcome.

Cycle Run summaries derive from durable attempts. `active_feeds` and `selected_feeds` count distinct Feeds, not Subscription rows. `checked_feeds` counts terminal attempts except `skipped`; `failed_feeds` counts the `failed` subset; `skipped_feeds` counts selected Feeds deliberately not checked; and `new_items` sums committed attempt counts. Completion only updates a running Cycle Run, so replay cannot rewrite its durable summary. Forced runs bypass due time but still exclude deactivated and unsubscribed Feeds.

Workflow logs use the Workflow instance ID as both the request correlation ID and Cycle Run ID. Per-Feed events also carry the stable attempt ID and Feed ID. Workflow logs omit User identity because polling work belongs to shared Feeds. Management request logs include the authenticated User when it is relevant. Analytics Engine delivery happens after durable D1 commits and is best effort, so an Analytics Engine outage cannot replay polling work or remove Cycle Run history.

Manual Feed health changes use the same Polling module as automatic failure transitions. The module checks the requesting User's Subscription inside the D1 mutation before changing shared Feed state. Deactivation and reactivation also fence any in-flight poll and complete its attempt as skipped, so a stale response cannot overwrite the manual decision. Reactivation clears error diagnostics and restores the 30-minute Backoff interval with immediate eligibility.

## Metrics

**Writes:** `createMetrics()` in `src/lib/metrics.ts` uses
`AnalyticsEngineBackend` to write fire-and-forget data points to Workers
Analytics Engine.

**Reads:** `createAnalyticsReader()` in `src/feed/analytics.ts` owns the
AE SQL dialect and `blob`/`double`/`index` column layout, runs four
aggregate queries in parallel, and returns typed domain projections.
The dashboard handler never sees raw AE rows.

**Real-time dashboard cards** (cycle timeline, feed health, reads per day)
query D1 directly and work without analytics. `createActivityReader()` owns the
Timeline's 20-Cycle-Run D1 projection. It follows Item-to-attempt-to-Cycle-Run
foreign keys and filters attempts and Items through the authenticated User's
Subscriptions. Cycle Run summaries are labeled as global, while the attributed
Item count is labeled for the User's Subscriptions. Older Items without durable
attribution are counted separately, and a missing Cycle Run history is shown as
unavailable rather than zero activity. Timestamp windows are not used. Attempt
rows expose the stable attempt and Feed IDs used in structured logs. The
Activity projection derives public diagnostics from outcome, error class, and
HTTP status instead of rendering stored error text, so response content and
credentials cannot reach the Timeline.

## Retention

The Monday cleanup delegates Item and polling-history policy to
`createRetentionManager()`. Items use the configured `ITEM_RETENTION_DAYS`
(default 30). An old Item is deleted only when no User has starred it; cleanup
then deletes every Item State row for that same deletable Item. If any User has
starred an Item, the Item and all Users' surviving Item State remain intact.
This policy applies equally to attributed and legacy Items.

Operational history has a fixed 90-day retention period. Cleanup processes up
to five 500-Item batches and five 100-Cycle-Run batches per invocation. Each
D1 batch deletes related records in reference-safe order. Before an expired
Feed attempt is deleted, retained Items referencing it are set to explicitly
unattributed and any matching Feed ownership pointer and lease are cleared;
attempts are then deleted before their Cycle Runs. The Timeline
reports such Items as having no retained Cycle Run attribution and explains
that their history either expired or predates attribution tracking. It never
reconstructs attribution from timestamps.

## Auth

`createApiTokenLifecycle()` is the sole owner of API Token persistence and
policy. Dashboard handlers delegate generation, listing, and revocation. The
GReader adapters delegate active-token lookup and hourly usage recording. The
weekly cron delegates seven-day revoked-token cleanup.

See [`docs/auth-flow.md`](auth-flow.md).

## Retained compatibility and limitations

The maintainer owns each item below. None has a second active implementation path.

| Item | Reason retained | Removal condition |
| --- | --- | --- |
| `feeds.last_fetched_at` and `feeds.last_new_item_at` | Additive migrations and the documented rollback window require the old schema to remain readable. New code neither reads nor writes these columns. | Remove with a destructive migration after the production observation window closes, the verified backup ages out, and no supported rollback Worker reads them. |
| `legacy_inferred`, `legacy_uncertain`, and `legacy_unknown` values | They preserve uncertainty in pre-migration Feed history instead of inventing precise events. | Remove each value only after production has no rows using it and the dashboard no longer needs to explain that state. |
| Item IDs derived from `guid ?? URL` without Feed identity | Current stores these IDs, so changing them would require an Item State and client-compatibility migration. Equal GUIDs across different Feeds can still collide. | Replace only with a tested identity migration that preserves API IDs and every User's Item State, or after a protocol version allows new IDs. |
| Nullable first-ingestion attribution | Items created before migration `0006` and Items whose 90-day history expired have no retained attempt. | This is permanent historical truth, not a field awaiting deletion. |

The old `force` Workflow payload and Pipeline configuration are removed. The deployment runbook requires old Workflows to drain or terminate before cutover, so the new Worker accepts only `triggerReason`.

## Wrangler configuration

One Worker, one D1 database, one Analytics Engine dataset, one Workflow.
Two cron triggers.  Secrets: `CF_ACCESS_AUD`, `CF_API_TOKEN`, `DEV_MODE`.
Vars: `ITEM_RETENTION_DAYS`, `CF_ACCOUNT_ID`, `DISPLAY_TIMEZONE`, `ANALYTICS_ENABLED`.
