# Architecture

This document describes the system as implemented. It is intended for developers and operators; deployment steps are in the [README](../README.md).

## Overview

The application runs as a Cloudflare Worker. Hono routes requests to the Google Reader-compatible API or the Access-protected management interface. Cloudflare D1 is the system of record. A scheduled Cloudflare Workflow polls Feeds; Workers Analytics Engine provides optional aggregate trends.

The main runtime components are:

- **GReader API:** accepts reader sync requests authenticated by API Tokens.
- **Management UI:** server-rendered Hono/JSX pages using htmx and Tailwind CSS; Cloudflare Access protects management routes.
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

- `/reader/*` and `/accounts/ClientLogin` implement the reader protocol and validate API Tokens.
- `/app/*`, `/tokens/*`, `/feeds/*`, and `/import` are management routes protected by Cloudflare Access JWT verification.

The polling cron starts a Workflow every 30 minutes. The Workflow processes eligible Feeds in bounded batches. Poll intervals adapt to Feed activity: quiet Feeds back off, new Items bring checks sooner, and server timing hints such as `<ttl>` and `Retry-After` are respected. Repeated errors can deactivate a Feed. Feed status and diagnostics are available in the dashboard; see [Troubleshooting](troubleshooting.md).

Cycle Runs and Feed attempts are durable in D1 so retries can recover from interrupted work and the dashboard can distinguish no work, skipped Feeds, and failures. Concurrent polling is guarded so that an older request cannot overwrite a newer Feed result. A weekly cleanup removes unstarred Items past the configured retention period and expires old polling history; starred Items are kept.

## Module boundaries

| Area | Owns |
| --- | --- |
| `src/routes/` and protocol adapters | HTTP routing, request validation, wire-format responses |
| `src/feed/subscriptions.ts` | Feed upsert and Subscription operations |
| `src/feed/item-state.ts` and `src/feed/stream.ts` | User-scoped reading state and API Stream queries |
| `src/feed/poll.ts` | Feed selection, ingestion, Backoff, error handling, and polling state |
| `src/feed/activity.ts` | D1-backed dashboard activity and Timeline projections |
| `src/feed/analytics.ts` | Optional Analytics Engine queries and mapping |
| `src/feed/retention.ts` | Bounded Item and operational-history cleanup |
| `src/domain/tokens/` | API Token generation, hashing, lookup, revocation, and retention |

Handlers and the Workflow connect domain modules to Cloudflare bindings and observability. Domain persistence uses D1 directly; there is one store implementation. Analytics delivery is secondary to durable D1 writes.

For authentication details, see [Auth flow](auth-flow.md). For supported protocol behavior, see the [Google Reader API reference](reference/greader-api.md). Key technical rationale is indexed in [Architecture Decision Records](decisions.md).
