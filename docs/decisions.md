# Decisions

Key technical choices made during planning, and the reasoning behind them.

---

## Why Cloudflare Workers (not a VPS or container)

The original question was whether to run FreshRSS or Miniflux in a container. Workers + D1 keeps
the entire stack on Cloudflare primitives, within the existing Cloudflare account already in use.
No new infrastructure to maintain.

---

## Why not self-host FreshRSS or Miniflux directly

Both are strong options. The decision to build bespoke was driven by:

1. Keeping everything on Cloudflare with no external server
2. Learning value — understanding the GReader protocol
3. Control over auth — native support for Cloudflare Access
4. Minimal feature surface — no need for the full feature set of either

If the bespoke approach proves painful to maintain, FreshRSS on a $5 VPS remains a straightforward fallback.

---

## Why Current as the client

Current's "river" model — no unread counts, content fades over time — addresses the inbox anxiety
that makes traditional RSS readers feel like work. It was the starting point for this investigation.

Current supports FreshRSS with a custom server URL, which is the entry point for connecting a
bespoke backend.

---

## Why FreshRSS impersonation (not The Old Reader or Miniflux)

Current's sync UI has fixed named service options. FreshRSS is the only option that:
- Accepts a custom server URL
- Uses the standard Google Reader API
- Requires only username + password

Miniflux also accepts a custom URL but uses a different API key authentication scheme. FreshRSS's
GReader API is the most widely documented and the closest to the raw protocol.

---

## Why Cloudflare Access (not passwords or magic links)

Cloudflare Access was already in use for another site on the same account — reusing it eliminates
the entire auth stack: no password hashing, no session management, no email delivery. Access
handles login externally and injects a signed JWT. The Worker verifies it and extracts the email
claim. User provisioning is a single upsert — Access policy is the gate.

---

## Why API tokens (not Cloudflare Access) for Current

The GReader `ClientLogin` protocol expects a username + password POST. There is no browser redirect
flow. Cloudflare Access cannot protect these routes.

The solution is two-layer:
- Cloudflare Access for the management UI
- Long-lived API token for the GReader client

The user authenticates via Access, generates a named token, pastes it into Current once. The token
can be revoked from the UI at any time. Only the SHA-256 hash is stored — same pattern as GitHub
personal access tokens.

---

## Why Hono + htmx (not a SPA)

The management UI has two screens and a handful of interactions. Hono's JSX renderer runs
server-side in the Worker with no client bundle. htmx handles dynamic interactions (token
revocation, generation response, OPML import result) via HTML attributes — no JS to write.

TanStack would be worth reconsidering if the UI grows to include per-user feed analytics or
complex client-side state.

---

## Why Workers static assets (not Pages)

Since the UI is minimal (server-rendered HTML + vendored htmx.min.js + compiled CSS), there is no
need for a separate static site deployment. Workers static assets serves `./public` directly
alongside the Worker — single deployment, single wrangler.jsonc.

---

## Multi-user feed fetching design

A naive implementation fetches each subscription separately, meaning 10 users subscribing to the
same feed results in 10 fetches per cron cycle. The schema separates `feeds` (shared, canonical)
from `subscriptions` (per-user). The cron queries distinct feeds with active subscribers and
fetches each once, using `ETag`/`Last-Modified` for conditional requests. Only `item_state` is
per-user — article content is stored once in `items`.

---

## Why Cloudflare Pipelines → R2/Iceberg for metrics (not Analytics Engine or D1)

The original implementation used **Workers Analytics Engine (WAE)**. It was replaced after two issues:

1. **Named-field records only** — WAE's `@workers-powertools/metrics` `AnalyticsEngineBackend`
   emits one `writeDataPoint()` call per metric. WAE's positional schema (`index1`, `blob1..N`,
   `double1..N`) works but is opaque — every column needs manual cross-referencing with docs.

2. **Paid-tier SQL API required** — the WAE SQL API requires a Cloudflare API token with
   "Account Analytics Read". Querying it from the Worker introduced another secret and a cross-origin
   request. The data was also not easily exportable for external tools.

The current approach:

- **`@workers-powertools/metrics` `PipelinesBackend`** writes named-field JSON records to a
  Cloudflare Pipeline (`METRICS_PIPELINE`). Named fields are self-documenting; no schema mapping
  needed.
- **Pipeline → R2 Data Catalog** rolls Parquet files into `rss-reader-metrics-store` every 5
  minutes as an Iceberg table (`rss_reader.metrics`). Files are immutable, backward-compatible,
  and independently exportable.
- **R2 SQL REST API** (see `src/lib/r2sql.ts`) queries the Iceberg table with standard SQL. No
  additional Cloudflare API token needed beyond an R2-scoped one.
- **Batched writes** — all metrics per logical unit of work are accumulated in-memory and flushed
  in a single `backend.write()` call. This cut pipeline write volume from ~67k individual calls
  over 14 days to a handful per cron cycle.
- **`ANALYTICS_ENABLED` toggle** — setting this var to `"false"` disables both Pipeline writes
  and R2 SQL queries without removing bindings. Useful when the pipeline is not configured in
  local dev or when cost control is needed.

The dashboard's real-time cards (cycle timeline, feed health, reads per day) query D1 directly,
so they work even when analytics are disabled. R2 SQL cards (30-day trend, feed velocity, fetch
performance, error rates) are rendered only when `ANALYTICS_ENABLED=true` and
`R2_SQL_AUTH_TOKEN` is set.

---

## Build order rationale

Recommended sequence:

1. D1 schema + migrations
2. GReader API with hardcoded token (validate protocol against Current early)
3. Feed fetcher cron
4. Cloudflare Access middleware
5. Token management UI
6. Feed management UI + OPML import
7. Wire real DB-backed token auth

Starting with the GReader API layer (step 2) using a temporary hardcoded token lets you validate
the protocol against Current before any auth infrastructure exists. The GReader response shapes
are the highest-risk unknown — getting Current connected early surfaces issues while the codebase
is still small.
