# Implementation Plan

## Decisions

- **Auth**: Cloudflare Access protects the UI. Worker verifies `Cf-Access-Jwt-Assertion` JWT.
  No KV, no session cookies, no Resend. `users` table retained for FK — auto-provisioned on first request.
- **GReader auth**: API tokens (two-layer — Access for UI, API token for Current/GReader)
- **Single user**: no admin endpoint; no user management UI
- **Drizzle**: owns both schema types and migrations (not raw SQL files)
- **UI**: Hono JSX server-rendered + htmx for interactivity. Tailwind v4 with shadcn-aesthetic
  design (no React client bundle). Layout: header + tabbed nav.
- **Local dev**: hardcoded dev user, gated on `process.env.NODE_ENV === 'development'`
- **Content trim**: 50KB per article before D1 insert
- **Testing**: vitest with TypeScript equivalents of FreshRSS GReader protocol test cases
- **OPML**: import only; immediate fetch on import; folder names preserved; report + skip duplicates
- **Feeds UI**: read-only subscription list (title, URL, folder, last fetched)
- **Status tab**: scaffold as disabled placeholder now

---

## Manual Setup Checklist

> Steps you must complete — I will not run these. Each is also in `README.md`.

- [x] `wrangler d1 create rss-reader` — copy the returned `database_id` into `wrangler.jsonc`
- [x] `wrangler d1 migrations apply rss-reader --local` — apply schema to local dev DB
- [x] `wrangler d1 migrations apply rss-reader --remote` — apply schema to production DB
- [x] Create a Cloudflare Access application scoped to the Worker's domain
- [x] Set Access policy: allow only your personal email
- [x] Copy the Access **Audience Tag** from the Access application settings
- [x] `wrangler secret put CF_ACCESS_AUD` — paste the audience tag
- [x] Add a custom domain to the Worker in the Cloudflare dashboard
- [x] Point the Cloudflare Access application at that custom domain

---

## UI Specification

- **Stack**: Hono JSX (server-rendered) + htmx + Tailwind v4. shadcn aesthetic via CSS/Tailwind — no React.
- **Header**: full-width, user email in a badge right-aligned, logout link beside it
- **Tabs** (just below header):
  - **Status** — disabled placeholder (future dashboard)
  - **Feed** — two cards on one page:
    - _Manage feeds_: read-only table of subscriptions (title, URL, folder, last fetched)
    - _Import OPML_: file upload, submit button, results list (imported / duplicates / errors)
  - **Access** — token management:
    - Generate new token (name input + button, raw token shown once via htmx swap)
    - Active tokens list (name, last used, revoke button per row)

---

## Phased Task List

> Build order: validate GReader protocol against Current early, before auth infrastructure exists.

---

### Phase 1 — Scaffolding & Schema ✅

- [x] Install deps: `drizzle-orm`, `drizzle-kit`, `rss-parser`, `vitest`, `zod`, `@cloudflare/vitest-pool-workers`, `@types/node`
- [x] `wrangler.jsonc`: D1 binding (`DB`), two cron triggers, `CF_ACCESS_AUD` + `HARDCODED_TOKEN` + `DEV_MODE` secrets, `ITEM_RETENTION_DAYS` var
- [x] TypeScript strict config (`tsconfig.json`) + `cloudflare.d.ts` ambient types ref
- [x] Drizzle schema `src/db/schema.ts`: all 6 tables with typed columns
- [x] `drizzle.config.ts`: point at D1, output migrations to `drizzle/`
- [x] Run `drizzle-kit generate` to produce initial migration SQL
- [x] Hono app entry point `src/index.tsx` — route skeleton, `Env` types from `wrangler types`
- [x] Vendor `public/htmx.min.js`
- [x] `.dev.vars` + `.dev.vars.sample` (gitignored / committed)
- [x] `src/lib/logger.ts` — structured JSON logger
- [x] `src/lib/crypto.ts` — SHA-256, item ID helpers, continuation token encode/decode

---

### Phase 2 — GReader API (hardcoded token) ✅

- [x] Vitest setup: `vitest.config.ts` with `cloudflareTest` + `readD1Migrations`, `src/test/setup.ts` with `applyD1Migrations`
- [x] `src/lib/db.ts` — Drizzle client factory
- [x] `src/middleware/token.ts` — hardcoded token middleware
- [x] `src/handlers/greader.ts` — all GReader endpoints with Zod validation + structured logging
- [x] `POST /accounts/ClientLogin`
- [x] `GET /reader/api/0/user-info`
- [x] `GET /reader/api/0/subscription/list`
- [x] `POST /reader/api/0/subscription/edit` (`ac=subscribe|unsubscribe|edit`)
- [x] `GET /reader/api/0/stream/contents` (feed/folder/reading-list, `xt` filter, continuation pagination)
- [x] `GET /reader/api/0/stream/items/ids`
- [x] `POST /reader/api/0/edit-tag` (read/unread/starred upsert into `item_state`)
- [x] `POST /reader/api/0/mark-all-as-read`
- [x] 20 passing vitest tests modelled on FreshRSS GReader test suite

---

### Phase 3 — Feed Fetcher Cron ✅

- [x] `src/handlers/cron.ts` `scheduled()` — dispatch on `event.cron` to two handlers
- [x] `fetchFeeds()`: query distinct feeds with active subscriptions
- [x] Conditional `fetch` with `ETag` / `Last-Modified`; skip parse on `304`
- [x] rss-parser + `nodejs_compat` flag: normalize RSS/Atom → `items` rows
- [x] Item ID: SHA-256 hash of `guid ?? url`, stored as hex string
- [x] `onConflictDoNothing` deduplication
- [x] Content trim to 50KB before insert
- [x] Per-feed error isolation (log, continue)
- [x] Update `feeds.etag`, `feeds.last_modified`, `feeds.last_fetched_at`
- [x] `purgeOldItems()`: weekly `0 3 * * 0` — deletes `item_state` then `items` older than `ITEM_RETENTION_DAYS`
- [x] 13 passing vitest tests (RSS, Atom, 304, ETag, dedup, content trim, error isolation, purge)

---

### Phase 4 — Cloudflare Access Auth ✅

- [x] `src/middleware/access.ts`: verify `Cf-Access-Jwt-Assertion` against Access public certs using `CF_ACCESS_AUD`
- [x] Extract `email` claim; upsert `users` row; attach `userId` + `email` to Hono context
- [x] Dev bypass: if `DEV_MODE === 'true'`, inject hardcoded dev user (never reaches prod)
- [x] Apply middleware to all `/app/*` routes
- [x] `GET /auth/logout` — redirect to Cloudflare Access logout URL

---

### Phase 5 — Management UI ✅

- [x] Tailwind v4 (`tailwindcss` + `@tailwindcss/cli`) with shadcn design tokens in `src/styles.css`
- [x] `src/views/layout.tsx` — HTML shell, Tailwind link, htmx script tag, DOCTYPE via `raw()`
- [x] `src/views/components/header.tsx` — email badge + logout link
- [x] `src/views/components/tabs.tsx` — tab nav (Status disabled, Feed, Access)
- [x] `src/views/app.tsx` — top-level view composing header + tabs + active tab content
- [x] **Access tab** (`src/views/access.tsx`):
  - Token list table (`TokenList` tbody with `hx-swap-oob` support, `TokenRow` with revoke button)
  - Generate form (`hx-post="/tokens/generate"`, token reveal shown once via htmx swap)
- [x] `src/handlers/tokens.tsx`: `GET /app`, `POST /tokens/generate`, `DELETE /tokens/:id`
- [x] `src/types/htmx.d.ts` — augments `hono/jsx` JSX.HTMLAttributes to allow `hx-*` attributes
- [x] Wire Access auth middleware onto `/app/*` and `/tokens/*` routes in `src/index.tsx`
- [x] `build:css` + `dev:css` scripts in `package.json`

---

### Phase 6 — Feed Management UI ✅

- [x] `src/views/feeds.tsx` — Feed tab with two cards
- [x] _Manage feeds card_: server-rendered table of subscriptions (title, URL, folder, last fetched)
- [x] `src/handlers/feeds_ui.tsx`: `GET /app/feeds` — query subscriptions joined with feeds for display
- [x] _Import OPML card_: file upload form, `hx-post="/import"`, `#import-result` target (handler in Phase 7)

---

### Phase 7 — OPML Import ✅

- [x] OPML parser (`src/lib/opml.ts`): walk `<outline>` tree, extract feed URL/title/folder (via `fast-xml-parser`)
- [x] `POST /import`: parse upload, bulk-subscribe new feeds, report duplicates, skip conflicts
- [x] On subscribe: upsert `feeds` row (`onConflictDoNothing`), create `subscriptions` row
- [x] After import: trigger immediate `fetchAndStoreFeed()` for each newly added feed via `c.executionCtx.waitUntil()`
- [x] htmx response fragment (`src/views/import.tsx`): imported count, duplicates skipped, error details
- [x] 9 passing Vitest tests: flat list, folder assignment, nested folders, missing attrs, empty body, malformed XML, folder-only, single outline

---

### Phase 9 — Metrics & Status Dashboard ✅

- [x] `src/lib/metrics.ts` — `createMetrics()` factory; typed events: `ParseEvent`, `ReadEvent`, `SubscriptionEvent`; WAE write binding; no-op guard when binding absent
- [x] `src/lib/wae.ts` — `queryWae()` client for Analytics Engine SQL API (REST, Bearer token)
- [x] `src/handlers/cron.ts` — `recordParse()` on success/failure with duration + article count
- [x] `src/handlers/greader.ts` — `recordRead()` on `edit-tag` when `isRead=1`; `recordSubscription()` on all three `subscription/edit` actions
- [x] `src/views/status.tsx` — Status tab: 3 KPI tiles (reads, parses, failures 7d), reads-by-day table, parse-per-feed table; `StatusUnconfigured` shown when credentials missing
- [x] `src/handlers/status.tsx` — `GET /app/status`; parallel WAE queries; error boundary
- [x] `wrangler.jsonc` — `CF_ACCOUNT_ID` var; `CF_API_TOKEN` secret comment
- [x] Status tab enabled in nav (`tabs.tsx`)
- [x] `src/middleware/trace.ts` — exhaustive request+response trace middleware; toggled via `TRACE_REQUESTS` env var
- [ ] `wrangler secret put CF_API_TOKEN` — set Cloudflare API token (Account Analytics Read permission)
- [ ] Set `CF_ACCOUNT_ID` in `wrangler.jsonc`

---

### Phase 8 — Wire Real Token Auth ✅

- [x] `src/middleware/token.ts`: SHA-256 hash lookup in `api_tokens WHERE revoked_at IS NULL`; updates `last_used_at` on every authenticated request
- [x] `src/handlers/greader.ts`: ClientLogin validates Passwd via same DB hash lookup (no more `HARDCODED_TOKEN`)
- [x] `src/test/greader.test.ts`: seeds a real `api_tokens` row in `beforeEach`; drops `HARDCODED_TOKEN` env injection
- [x] Removed `HARDCODED_TOKEN` from `wrangler.jsonc` secrets comment
