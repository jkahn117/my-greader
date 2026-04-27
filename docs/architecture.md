# Architecture

## Project Structure

```
src/
  index.tsx              — Hono app entry point, route registration, Worker export
  middleware/
    access.ts            — Cloudflare Access JWT verification (UI routes)
    token.ts             — GReader API token middleware (SHA-256 hash lookup)
    observability.ts     — request/response logging middleware
  handlers/
    greader/
      index.ts           — mounts all GReader sub-routers
      auth.ts            — POST /accounts/ClientLogin
      stream.ts          — GET /reader/api/0/stream/contents + stream/items/ids
      state.ts           — POST /reader/api/0/edit-tag + mark-all-as-read
      subscriptions.ts   — GET/POST /reader/api/0/subscription/* + tag/list
      helpers.ts         — shared stream ID parsing, type definitions
    cron.ts              — scheduled entry point; fetchAndStoreFeed; purgeOldItems
    metrics.tsx          — GET /app/metrics (D1 + R2 SQL dashboard)
    tokens.tsx           — GET /app, POST /tokens/generate, DELETE /tokens/:id
    feeds_ui.tsx         — GET /app/feeds
    import.tsx           — POST /import (OPML)
  workflows/
    feed_polling.ts      — FeedPollingWorkflow (Cloudflare Workflow)
  views/
    layout.tsx           — HTML shell (Tailwind, htmx)
    app.tsx              — top-level page: header + tabs + content
    access.tsx           — Access tab (token list + generate form)
    feeds.tsx            — Feed tab (subscription list + OPML import)
    metrics.tsx          — Metrics tab (all dashboard cards + types)
    import.tsx           — ImportResult htmx fragment
    components/
      header.tsx         — email badge + logout link
      tabs.tsx           — Metrics / Feed / Access tab nav
  lib/
    crypto.ts            — SHA-256, item ID helpers, continuation token encode/decode
    dates.ts             — relativeTime, shortUtc formatting helpers
    db.ts                — Drizzle client factory
    logger.ts            — structured JSON logger (@workers-powertools/logger)
    metrics.ts           — Pipeline metric write client (createMetrics factory)
    opml.ts              — OPML parser (fast-xml-parser)
    r2sql.ts             — R2 SQL REST API query client
    tracer.ts            — per-operation span tracing (@workers-powertools/tracer)
  db/
    schema.ts            — Drizzle schema for all 7 tables
  types/
    htmx.d.ts            — JSX type augmentation for hx-* attributes
  test/
    greader.test.ts      — GReader protocol tests
    cron.test.ts         — feed fetcher + purge tests
    opml.test.ts         — OPML parser tests
    setup.ts             — vitest environment setup

public/
  htmx.min.js            — vendored, no CDN dependency
  styles.css             — compiled Tailwind output (do not edit directly)
  favicon.ico

src/
  styles.css             — Tailwind v4 source with shadcn design tokens
```

---

## Wrangler Configuration

```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "rss-reader" }],
  "pipelines": [{ "pipeline": "<pipeline-id>", "binding": "METRICS_PIPELINE" }],
  "r2_buckets": [{ "bucket_name": "rss-reader-metrics-store", "binding": "rss_reader_metrics_store" }],
  "workflows": [{ "name": "feed-polling", "binding": "FEED_POLLING_WORKFLOW", "class_name": "FeedPollingWorkflow" }],
  "triggers": {
    "crons": ["*/30 * * * *", "0 3 * * 1"]
  },
  "vars": {
    "ITEM_RETENTION_DAYS": "30",     // days before articles are purged
    "CF_ACCOUNT_ID": "<account-id>", // used by R2 SQL query client
    "DISPLAY_TIMEZONE": "UTC",       // IANA tz for reads-per-day grouping
    "ANALYTICS_ENABLED": "true"      // set "false" to disable Pipeline writes + R2 SQL
  }
  // Secrets (wrangler secret put):
  // CF_ACCESS_AUD      — Cloudflare Access audience tag (JWT verification)
  // R2_SQL_AUTH_TOKEN  — R2 API token for querying pipeline analytics
  // DEV_MODE           — set "true" in .dev.vars only; bypasses Access JWT locally
}
```

---

## D1 Schema

```sql
-- Authorised users — single user in practice, keyed for FK relationships
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Canonical feed registry — shared across all users.
-- Each unique feed URL is fetched once regardless of subscriber count.
CREATE TABLE feeds (
  id                    TEXT PRIMARY KEY,
  feed_url              TEXT UNIQUE NOT NULL,
  html_url              TEXT,
  title                 TEXT,
  last_fetched_at       INTEGER,
  etag                  TEXT,           -- for conditional HTTP requests
  last_modified         TEXT,           -- for conditional HTTP requests
  consecutive_errors    INTEGER DEFAULT 0 NOT NULL,
  last_error            TEXT,           -- most recent error message
  deactivated_at        INTEGER,        -- NULL = active; set after 5 consecutive errors
  check_interval_minutes INTEGER DEFAULT 30 NOT NULL,  -- adaptive backoff: 30→60→120→240 min
  last_new_item_at      INTEGER         -- epoch ms of last stored article; NULL if never
);

-- Per-user feed subscriptions
CREATE TABLE subscriptions (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL REFERENCES users(id),
  feed_id  TEXT NOT NULL REFERENCES feeds(id),
  title    TEXT,     -- user's custom title, overrides feed default if set
  folder   TEXT,     -- maps to GReader labels; one folder per subscription
  UNIQUE (user_id, feed_id)
);

-- Fetched articles — shared, not per-user
CREATE TABLE items (
  id            TEXT PRIMARY KEY,   -- SHA-256 hex of guid ?? url
  feed_id       TEXT NOT NULL REFERENCES feeds(id),
  title         TEXT,
  url           TEXT,
  content       TEXT,               -- trimmed to 50KB before insert
  author        TEXT,
  published_at  INTEGER,
  fetched_at    INTEGER
);

-- Per-user read and starred state
CREATE TABLE item_state (
  item_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  is_read     INTEGER DEFAULT 0,
  is_starred  INTEGER DEFAULT 0,
  read_at     INTEGER,              -- epoch ms when last marked read; used for reads-per-day chart
  PRIMARY KEY (item_id, user_id)
);

-- One row per FeedPollingWorkflow run — written in the record-cycle step.
-- Backing store for the polling cycle timeline in /app/metrics.
CREATE TABLE cycle_runs (
  id             TEXT PRIMARY KEY,  -- epoch ms as string
  ran_at         INTEGER NOT NULL,
  active_feeds   INTEGER NOT NULL DEFAULT 0,
  due_feeds      INTEGER NOT NULL DEFAULT 0,
  checked_feeds  INTEGER NOT NULL DEFAULT 0,
  new_items      INTEGER NOT NULL DEFAULT 0,
  failed_feeds   INTEGER NOT NULL DEFAULT 0
);

-- API tokens used by GReader clients (e.g. Current)
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,          -- human label, e.g. "Current on iPhone"
  token_hash   TEXT UNIQUE NOT NULL,   -- SHA-256 of raw token; raw shown once only
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER                 -- NULL = active
);
```

### Notes

- `items` is shared — article content is stored once per feed, regardless of subscriber count
- Only `subscriptions` and `item_state` are per-user
- `api_tokens` stores only the hash; the raw token is shown once and never persisted
- `check_interval_minutes` starts at 30 and doubles on each poll cycle with no new content, capped at 240 (4 h). Resets to 30 when new content is found.
- `cycle_runs` is the authoritative source for the dashboard's polling history; the Pipeline is a separate long-term store

---

## Pipeline Metrics Schema

Metric events are written via `createMetrics()` in `src/lib/metrics.ts` using the
`@workers-powertools/metrics` `PipelinesBackend`. All events are flushed as a single
batched `backend.write()` call per logical unit of work. Records land in R2
(`rss-reader-metrics-store`) as Iceberg/Parquet files and are queryable via the R2 SQL API.

Set `ANALYTICS_ENABLED=false` to disable all writes and queries.

| Metric name              | When emitted                        | Key dimensions                      |
| ------------------------ | ----------------------------------- | ----------------------------------- |
| `feed_parse_duration_ms` | After each feed fetch (success)     | `feedId`, `status`                  |
| `feed_new_articles`      | When new articles are stored        | `feedId`                            |
| `feed_parse_failure`     | On parse error                      | `feedId`, `error` (truncated 128 b) |
| `feed_fetch_error`       | On 429 / non-OK HTTP response       | `feedId`, `httpStatus`              |
| `cycle_new_articles`     | End of each Workflow run            | —                                   |
| `cycle_failed_feeds`     | End of each Workflow run            | —                                   |
| `cycle_checked_feeds`    | End of each Workflow run            | —                                   |
| `cycle_error`            | Workflow-level failure              | `error` (truncated 128 b)           |
| `article_read`           | GReader `edit-tag` marks read       | `userId`, `feedId`                  |
| `subscription_change`    | Subscribe / unsubscribe / edit      | `userId`, `action`                  |

Queried in `src/handlers/metrics.tsx` via the R2 SQL client in `src/lib/r2sql.ts`.

---

## Auth

Management UI routes (`/app/*`, `/tokens/*`, `/import`) are protected by `accessMiddleware` in
`src/middleware/access.ts`. It verifies the `Cf-Access-Jwt-Assertion` JWT injected by Cloudflare
Access, extracts the `email` claim, and upserts the `users` row on first login.

GReader API routes (`/reader/*` and `/accounts/ClientLogin`) are authenticated via
`tokenMiddleware` in `src/middleware/token.ts`. It SHA-256 hashes the bearer token and
looks it up in `api_tokens`.

See [`docs/auth-flow.md`](auth-flow.md) for full details.

---

## Cron Jobs

Two triggers. `scheduled()` in `src/handlers/cron.ts` dispatches on `event.cron`:

```typescript
switch (event.cron) {
  case '*/30 * * * *': return triggerFeedPollingWorkflow(env);
  case '0 3 * * 1':   return purgeOldItems(env);
}
```

### Feed fetcher (`*/30 * * * *`) — FeedPollingWorkflow

The cron trigger creates a new `FeedPollingWorkflow` instance (Cloudflare Workflow) and returns
immediately. The Workflow runs asynchronously in its own durable execution context.

**Why a Workflow?** The free plan limits each Worker invocation to 50 subrequests. Each feed
fetch costs ~2 (1 HTTP GET + 1 D1 write). Workflows solve this because each sequential
`step.do()` runs in a fresh Worker invocation with a fresh budget — there is no cap on the
total number of feeds.

**Steps:**

1. `get-due-feeds` — query feeds with elapsed `check_interval_minutes` (stale-first ordering)
2. `fetch-batch-N` (one step per 20 feeds) — concurrent `Promise.allSettled` within each step:
   - Conditional `fetch` with stored `ETag` / `Last-Modified`
   - On `304 Not Modified`: update `last_fetched_at`, double the interval
   - On `429`: back off interval (respects `Retry-After`), do not increment error count
   - On other non-OK: increment `consecutive_errors`, set `last_error`; deactivate at 5
   - On parse success: upsert items, reset error count, update `last_new_item_at`
   - Adaptive interval: reset to 30 min if new items; double up to 4 h if not
   - Content trimmed to 50KB; `onConflictDoNothing` for dedup
3. `record-cycle` — insert one row into `cycle_runs`; flush Pipeline metrics

### Article cleanup (`0 3 * * 1`)

Runs Mondays 03:00 UTC. Deletes articles older than `ITEM_RETENTION_DAYS` (default: 30).
Prunes `item_state` first to satisfy the FK constraint, then `items`.
