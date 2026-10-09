# Architecture

This document describes the system as implemented. It is intended for developers and operators; deployment steps are in the [README](../README.md).

## Overview

The application runs as a Cloudflare Worker. Hono routes requests to the Google Reader-compatible API or the Access-protected management interface. Cloudflare D1 is the system of record. A scheduled Cloudflare Workflow polls Feeds; Workers Analytics Engine provides optional aggregate trends.

The main runtime components are:

- **GReader API:** accepts reader sync requests authenticated by API Tokens.
- **Management UI:** a React SPA built with Vite, TanStack Router, shadcn components, and Tailwind CSS; Cloudflare Access protects the dashboard hostname, and Hono verifies Access JWTs for its same-origin JSON APIs.
- **Feed polling:** a scheduled Workflow coordinates fetching, parsing, Item ingestion, health updates, and durable polling history.
- **D1:** stores Users, shared Feeds and Items, per-User Subscriptions and Item State, API Tokens, and operational history.
- **Analytics Engine:** stores optional aggregate metrics. Its failure does not affect durable D1 data.

## Data ownership

- `feeds` holds canonical Feed records shared by subscribers. A Feed is polled once per cycle regardless of how many Users subscribe to it.
- `subscriptions` records each User's relationship to a Feed, including custom title and Folder.
- `items` stores shared Item content. `item_state` stores each User's read and starred state.
- `api_tokens` stores hashes and lifecycle metadata, never raw API Tokens.
- `cycle_runs` and `feed_poll_attempts` record polling progress and outcomes for the dashboard and troubleshooting.

The schema is defined in `src/db/schema.ts`; ordered migrations are in `drizzle/`. Migrations preserve existing Item IDs, Subscriptions, Item State, and API Token data. Legacy Feed history that cannot be determined precisely remains unknown rather than being inferred from timestamps.

## Request and polling flow

The Worker exposes two authentication paths:

- `/reader/*` and `/accounts/ClientLogin`, also mounted under `/api/greader.php`, implement the reader protocol and validate API Tokens.
- `/app/api/*` exposes management JSON APIs protected by Worker-side Cloudflare Access JWT verification. The old top-level management endpoints have been removed.
- `/app` and client routes under `/app/*` are served through Workers static assets with a single-page-application fallback. The hostname-wide Access application protects the HTML shell and assets at the edge; static asset requests do not run Hono's JWT middleware.

`assets.run_worker_first` in `wrangler.jsonc` sends `/`, `/app/api/*`, reader routes, and logout to Hono rather than the SPA fallback. `/` redirects to `/app`; the client resolves `/app` to Overview. API bypass policies belong only on reader protocol paths, not the dashboard JSON APIs.

The polling cron starts a Workflow every 30 minutes. The Workflow processes eligible Feeds in sequential batches of eight, with concurrent polling within each step to stay within subrequest limits. Selection is global over active subscribed Feeds; normal manual polling uses the same due-time policy. Forced polling bypasses only due time, not Deactivation or the requirement for a Subscription. Poll intervals adapt to Feed activity: quiet Feeds back off, new Items bring checks sooner, and server timing hints such as `<ttl>` and `Retry-After` are respected. Repeated errors can deactivate a Feed. Feed status and diagnostics are available in the dashboard; see [Troubleshooting](troubleshooting.md).

`src/lib/feed-parser.ts` validates XML and normalizes Feedsmith's RSS, Atom, and RDF models for polling; malformed XML can use the existing lenient linkedom fallback. Strict Atom and RDF parsing retains URL-derived Item IDs rather than treating Atom `id` or RDF `about` as GUIDs. RSS publication dates prefer `pubDate` over the first `dc:date`; an invalid selected date falls back to ingestion time. The fallback retains its prior format-specific identity behavior so previously ingested Items and Item State remain linked.

Cycle Runs and Feed attempts are durable in D1 so retries can recover from interrupted work and the dashboard can distinguish no work, skipped Feeds, and failures. The Workflow instance ID identifies a Cycle Run; `${cycleRunId}:${feedId}` identifies a logical attempt reused on step retries. Empty selection completes durably without polling. Non-empty completion is reconciled from terminal attempts, not optional analytics. Concurrent polling uses a per-Feed lease and monotonic fence so an older request cannot overwrite a newer Feed result; manual health transitions cancel owned work.

Items link to their first ingestion attempt through `items.first_ingestion_attempt_id`; history never reconstructs attribution from timestamps. A weekly cleanup removes Items past the configured fetched-time retention period only when no User has starred them, deletes their Item State, and expires Cycle Runs and attempts after 90 days. Cleanup is bounded, so expired rows may remain until a later cleanup. Retained Items lose expired attempt references before history deletion. Revoked API Tokens have a separate seven-day retention policy.

## Module boundaries

| Area | Owns |
| --- | --- |
| `src/index.tsx` and `src/handlers/` | Hono routing, request validation, protocol and JSON responses |
| `src/client/` | React pages, TanStack Router loaders, same-origin API calls, browser interaction |
| `src/shared/dashboard-api.ts` | Dashboard request/response types shared by Worker and client |
| `src/feed/subscriptions.ts` | Feed upsert and Subscription operations |
| `src/feed/item-state.ts` and `src/feed/stream.ts` | User-scoped reading state and API Stream queries |
| `src/feed/poll.ts` | Feed selection, ingestion, Backoff, error handling, and polling state |
| `src/feed/activity.ts` | D1-backed Overview, activity, and Cycle Run projections |
| `src/feed/history.ts` | Durable attempt pagination, terminal-check streaks, problem groups, attributed Items |
| `src/feed/reading.ts` | Display-timezone day boundaries and current-Subscription marked-read projections |
| `src/feed/analytics.ts` | Optional Analytics Engine queries and mapping |
| `src/feed/retention.ts` | Bounded Item and operational-history cleanup |
| `src/domain/tokens/` | API Token generation, hashing, lookup, revocation, and retention |

Handlers and the Workflow connect domain modules to Cloudflare bindings and observability. Domain persistence uses D1 directly; there is one store implementation. Analytics delivery is secondary to durable D1 writes.

## Management client and reading semantics

The React entry is `src/client/main.tsx`, loaded by `index.html`. TanStack Router uses basepath `/app`, with Overview, Feeds, Feed detail, Reading, and Access routes. Loaders and controls call `/app/api/*` through `src/client/lib/api.ts`; shared types are compile-time contracts, not runtime response validation. The old htmx pages, Metrics tab, and Timeline tab are removed. Overview shows the latest global Cycle Run lifecycle; Feed detail exposes per-Feed attempt evidence rather than a browsable Cycle Run timeline.

The Reading endpoint accepts `days=7|14|30`. It counts current `item_state` rows with `is_read = 1` and a `read_at` receipt in the selected display-timezone calendar-day window. `edit-tag` stamps every explicit mark-read (a repeated mark replaces its receipt) and clears the receipt on unread. `mark-all-as-read` stamps only previously unread Items; it does not re-date already-read Items. Counts are scoped to current Subscriptions, including deactivated Feeds and excluding unsubscribed Feeds. Starred count is current state, not windowed. Today is partial; missing days are zero-filled. Invalid `DISPLAY_TIMEZONE` falls back to UTC on both Reading and Overview. Overview's reading chart uses the same calendar-day boundaries; its summary KPIs retain a rolling seven-day window. Retention can remove older unstarred Items and their receipts. These are marked-read facts, not a read-event log or measures of time spent reading. Overview's rolling-seven-day summaries are distinct from Reading's calendar-day window.

Vite with the Cloudflare and React plugins builds the SPA into `dist/client` and the Worker into `dist/my_greader`. `pnpm deploy` builds both; do not deploy an old client bundle with a new JSON API. Playwright acceptance tests in `e2e/` run against the local Vite server (`pnpm test:browser`); Worker/D1 tests run in separate development and production-auth modes.

For authentication details, see [Auth flow](auth-flow.md). For supported protocol behavior, see the [Google Reader API reference](reference/greader-api.md). Key technical rationale is indexed in [Architecture Decision Records](decisions.md).
