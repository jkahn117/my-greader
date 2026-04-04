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
