# Architecture

## Project Structure

```
src/
  index.tsx              — Hono app entry point, route registration, Worker export
  middleware/
    access.ts            — Cloudflare Access JWT verification middleware (UI routes)
    token.ts             — GReader API token middleware (SHA-256 hash lookup)
    trace.ts             — exhaustive request+response trace middleware (TRACE_REQUESTS=true)
  handlers/
    greader.ts           — all GReader API endpoints
    cron.ts              — scheduled feed fetcher + article cleanup
    metrics.tsx          — GET /app/metrics (Analytics Engine dashboard)
    tokens.tsx           — GET /app/access, POST /tokens/generate, DELETE /tokens/:id
    feeds_ui.tsx         — GET /app/feeds
    import.tsx           — POST /import (OPML)
  views/
    layout.tsx           — HTML shell (Tailwind, htmx)
    app.tsx              — top-level page: header + tabs + content
    access.tsx           — Access tab (token list + generate form)
    feeds.tsx            — Feed tab (subscription list + OPML import)
    metrics.tsx          — Metrics tab (KPI tiles + parse/read tables)
    import.tsx           — ImportResult htmx fragment
    components/
      header.tsx         — email badge + logout link
      tabs.tsx           — Metrics / Feed / Access tab nav
  lib/
    crypto.ts            — SHA-256, item ID helpers, continuation tokens
    db.ts                — Drizzle client factory
    logger.ts            — structured JSON logger
    metrics.ts           — Workers Analytics Engine write client (createMetrics factory)
    opml.ts              — OPML parser (fast-xml-parser)
    wae.ts               — Analytics Engine SQL API query client
  db/
    schema.ts            — Drizzle schema for all 6 tables
  types/
    htmx.d.ts            — JSX type augmentation for hx-* attributes
  test/
    greader.test.ts      — 20 GReader protocol tests
    cron.test.ts         — 13 feed fetcher + purge tests
    opml.test.ts         — 9 OPML parser tests

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
  "analytics_engine_datasets": [{ "binding": "READER_METRICS", "dataset": "rss-reader-data" }],
  "triggers": {
    "crons": ["*/30 * * * *", "0 3 * * 1"]
  },
  "vars": {
    "ITEM_RETENTION_DAYS": "30",  // days before articles are purged
    "TRACE_REQUESTS": "false",    // set "true" to enable full request/response logging
    "CF_ACCOUNT_ID": ""           // Cloudflare account ID for WAE SQL API queries
  }
  // Secrets (wrangler secret put):
  // CF_ACCESS_AUD  — Cloudflare Access audience tag
  // CF_API_TOKEN   — Cloudflare API token (Account Analytics Read) for metrics dashboard
  // DEV_MODE       — set "true" in .dev.vars only; bypasses Access JWT locally
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

-- Canonical feed registry — shared across all users
-- Each unique feed URL is fetched once regardless of subscriber count
CREATE TABLE feeds (
  id                TEXT PRIMARY KEY,
  feed_url          TEXT UNIQUE NOT NULL,
  html_url          TEXT,
  title             TEXT,
  last_fetched_at   INTEGER,
  etag              TEXT,         -- for conditional HTTP requests
  last_modified     TEXT          -- for conditional HTTP requests
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
  id            TEXT PRIMARY KEY,   -- SHA-256 hex of guid or URL
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
  PRIMARY KEY (item_id, user_id)
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

- `items` is shared storage — article content is the same for all subscribers
- Only `subscriptions` and `item_state` are per-user
- `api_tokens` stores only the hash; the raw token is shown to the user once and never stored

---

## Analytics Engine Schema

Events are written via the `READER_METRICS` binding using `createMetrics()` in `src/lib/metrics.ts`.
All events share one dataset. Positional schema:

Free plan limit: 1 index per data point. Event type is the sole index; dimensions use blobs.

| Event | index1 | blob1 | blob2 | blob3 | blob4 | double1 | double2 |
|---|---|---|---|---|---|---|---|
| `parse` | `"parse"` | feedId | `"success"\|"failure"` | error msg | — | durationMs | articleCount |
| `read` | `"read"` | userId | articleId | — | — | — | — |
| `subscription` | `"subscription"` | userId | feedId | action | folder | — | — |

Queried via the Cloudflare Analytics Engine SQL API in `src/lib/wae.ts` using `CF_API_TOKEN`.

---

## Auth

Management UI routes (`/app/*`, `/tokens/*`, `/import`) are protected by `accessMiddleware` in
`src/middleware/access.ts`. It verifies the `Cf-Access-Jwt-Assertion` JWT injected by Cloudflare
Access, extracts the `email` claim, and upserts the `users` row on first login.

GReader API routes (`/reader/*`) are protected by `tokenMiddleware` in `src/middleware/token.ts`.
It SHA-256 hashes the bearer token and looks it up in `api_tokens`.

See [`docs/auth-flow.md`](auth-flow.md) for full details.

---

## Cron Jobs

Two triggers. `scheduled()` in `src/handlers/cron.ts` dispatches on `event.cron`:

```typescript
switch (event.cron) {
  case '*/30 * * * *': return fetchFeeds(env)
  case '0 3 * * 0':   return purgeOldItems(env)
}
```

### Feed fetcher (`*/30 * * * *`)

1. Query all feeds that have at least one active subscription
2. Conditional `fetch` with stored `ETag` / `Last-Modified` headers
3. On `304 Not Modified` — skip parsing, update `last_fetched_at` only
4. On `200` — parse RSS/Atom with `rss-parser`, upsert new items
5. Content trimmed to 50KB before insert; `onConflictDoNothing` for dedup
6. Per-feed errors are logged and isolated — one bad feed never blocks others
7. `recordParse()` emitted on success and failure with duration + article count

### Article cleanup (`0 3 * * 1`)

Runs Mondays 03:00 UTC. Deletes articles older than `ITEM_RETENTION_DAYS` (default: 30).
Prunes `item_state` first to satisfy the FK constraint, then `items`.
