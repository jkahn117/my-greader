# Auth Flow

## Overview

No passwords exist anywhere in this system. The management UI is protected by Cloudflare Access
(handles login externally). API tokens for GReader clients are generated through the
Access-protected web UI and can be revoked at any time.

---

## Web UI Auth — Cloudflare Access

The hostname-wide Cloudflare Access application protects the React dashboard at `/app`
and its static assets. Dashboard JSON APIs under `/app/api/*` also run `accessMiddleware`
(`src/middleware/access.ts`) in Hono. Static SPA routes are served asset-first and do not
run Worker JWT verification; they contain no User data until the client calls the protected
JSON APIs. The old `/tokens/*`, `/feeds/*`, and `/import` adapters are removed.
Cloudflare Access handles login entirely — the Worker never sees credentials. Keep Access
bypass policies limited to reader protocol routes, not `/app/api/*`.

On authenticated requests forwarded to the Worker, Access injects a signed JWT:

```
Cf-Access-Jwt-Assertion: <jwt>
```

The Worker requires `iss` to exactly match `CF_ACCESS_ISSUER`, a configured HTTPS
team origin without a trailing slash, credentials, or path. It fetches public
JWKS only from `${CF_ACCESS_ISSUER}/cdn-cgi/access/certs`, with redirects disabled.
The assertion cannot choose its own key service.

Only `RS256` is allowed, with a non-empty string `kid`. Claims `iss`, `sub`, and
`email` must be non-empty strings; `aud` must be a non-empty string or non-empty
array of non-empty strings containing `CF_ACCESS_AUD`. `iat` and `exp` must be
finite integers. Tokens expire when `exp <= floor(Date.now() / 1000)`, with no
expiry leeway. There is no future-`iat` restriction pending an agreed clock-skew
policy. Real Web Crypto verifies the RSA signature before any User is provisioned.

Missing assertions and invalid assertions return `401 Unauthorized`. An assertion
with missing audience or missing/invalid issuer configuration returns
`500 Authentication unavailable`. Malformed encoding, JSON, claims, keys, and
signature data, as well as JWKS HTTP/network failures, are controlled rejections.

The isolate retains one issuer-scoped JWKS cache for one hour. At the TTL boundary
it must fetch keys again; service failures never fall back to expired keys. If a
key ID is absent from fresh cached keys, the Worker refreshes once and retries the
lookup. A newly fetched JWKS missing the key is rejected without another fetch.
Keys removed by the service remain usable while their cached key set is fresh.
After a successful refresh replaces that set, removed keys are rejected. The
production HTTP tests cover rotation both before and exactly at cache expiry,
retired-key rejection, and HTTP, network, JSON, and schema failures during refresh.
An explicit module-reset test proves a new Worker module cannot reuse the old
module's keys. Independent tests reset module state; cache-policy tests preserve
state and control time. No verification helpers are exported for testing.

### User provisioning

On the first verified request, the Worker auto-provisions a `users` row using the JWT `sub`
claim as the stable user ID:

```typescript
await db.insert(users)
  .values({ id: payload.sub, email: payload.email, createdAt: Date.now() })
  .onConflictDoNothing()
```

Access policy controls who can reach the Worker — the `users` table just maps identity → stable
`user_id` for FK relationships.

### Logout

`GET /auth/logout` redirects to the Cloudflare Access logout endpoint on the same domain:

```
https://<worker-domain>/cdn-cgi/access/logout
```

The logout URL is derived from the incoming request's host — no additional config required.

### Local development

`pnpm dev` supplies `DEV_MODE=true` in a serve-only Vite override to bypass JWT verification locally. The middleware injects a
hardcoded dev user (`dev-user-id` / `dev@localhost`) without checking for a JWT header.
This path is gated on `DEV_MODE === 'true'` and never executes in production.

---

## GReader API Auth — API Tokens

The GReader `ClientLogin` protocol uses a username + password POST — browser redirects are not
possible. Cloudflare Access cannot protect these routes. API tokens are the bridge.

### Generation

1. Authenticated User visits the React page `/app/access`
2. Enters a token name (e.g. "Current on iPhone") and clicks Generate
3. `POST /app/api/tokens` accepts JSON `{ "name": "Current on iPhone" }` and delegates to `createApiTokenLifecycle()`:
   - The trimmed name must contain 1–100 characters
   - The module generates 32 cryptographically random bytes encoded as a 64-char hex string
   - It SHA-256 hashes the token and stores only the hash in `api_tokens`
   - The handler returns `201` JSON containing the raw token once, with `Cache-Control: no-store`; the raw value is never persisted or returned by later reads
4. User copies the raw token into Current's password field; the page also shows same-origin FreshRSS connection settings and the authenticated email

`GET /app/api/tokens` returns the User's active and retained revoked tokens with name,
creation time, coarse last-used time, and revocation state. It exposes neither hashes nor
raw values. The client keeps a newly generated raw value only in page state, not browser
storage.

### ClientLogin rate limiting

Before API Token validation, ClientLogin delegates to the native Workers
`LOGIN_RATE_LIMITER` binding, configured for five attempts per sixty seconds.
The key is `CF-Connecting-IP`. Requests without that header share the literal
`unknown` key; the Worker does not trust other forwarding headers as a substitute.
An allow decision proceeds with normal API Token authentication. A deny decision
returns `429 Rate limited`, without an Auth response. If the binding throws,
the Worker fails closed with `503 Authentication unavailable` and logs a
structured error without platform exception details.

An absent binding retains the existing optional runtime behavior, proceeding
with authentication. A focused test of `wrangler.jsonc` requires the production
binding and its intended limit so configuration omissions fail the local/CI gate.
Local tests verify adapter decisions, not Cloudflare's distributed enforcement.

### Usage (GReader ClientLogin)

```
POST /accounts/ClientLogin
Body: Email=user@example.com&Passwd=<raw-token>

1. Worker SHA-256 hashes the Passwd value
2. Looks up hash in api_tokens WHERE revoked_at IS NULL
3. On match: returns Auth=<raw-token> (echoed back)
4. All subsequent GReader requests use:
   Authorization: GoogleLogin auth=<raw-token>
5. Each request delegates active lookup and usage recording to the API Token module. The module updates `last_used_at` at most once per hour.
```

### Revocation

1. User visits `/app/access`, sees tokens with name, creation time, last-used time, and state
2. Clicks Revoke and confirms the named token inline
3. `DELETE /app/api/tokens/:id` asks the API Token module to set `revoked_at`. Ownership is verified against `userId`; another User's token returns `404` without changes. Repeated revocation of an owned revoked token is idempotent.
4. The client refreshes the loader and shows the token as Revoked
5. Any subsequent GReader request with that token receives `401 Unauthorized`
6. Weekly cleanup removes tokens that have been revoked for at least seven days, using the same module policy.

The API Token module owns generation, hashing, lookup, usage recording, listing,
revocation, and retention. HTTP adapters still own Cloudflare Access checks,
header and form parsing, rate limiting, logging, and wire responses.

---

## Route Summary

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/app`, `/app/overview` | Access at edge | React Overview (default client route) |
| GET | `/app/feeds`, `/app/feeds/:feedId` | Access at edge | React Subscription workspace and Feed detail |
| GET | `/app/reading` | Access at edge | React marked-read metrics |
| GET | `/app/access` | Access at edge | React API Token management |
| GET | `/app/api/overview`, `/app/api/overview/panels` | Access JWT | D1 summaries and optional Analytics Engine trend |
| GET | `/app/api/feeds` | Access JWT | User's Subscriptions and Feed health |
| GET | `/app/api/feeds/:feedId` | Access JWT | Subscribed Feed detail; otherwise `404` |
| GET | `/app/api/feeds/:feedId/attempts` | Access JWT | Cursor-paginated durable attempts; default 25, maximum 50 |
| GET | `/app/api/reading?days=7\|14\|30` | Access JWT | Calendar-day marked-read projection |
| GET | `/app/api/tokens` | Access JWT | Token summaries and connection settings |
| POST | `/app/api/tokens` | Access JWT | Generate API Token (JSON, raw value once) |
| DELETE | `/app/api/tokens/:id` | Access JWT | Revoke owned token (JSON) |
| POST | `/app/api/import` | Access JWT | Multipart `opml` upload; imported/duplicate/error counts |
| POST | `/app/api/feeds/sync` | Access JWT | Start global eligible-Feed polling; JSON `{ "force": true }` bypasses due time only |
| POST | `/app/api/feeds/:feedId/deactivate` | Access JWT | Manually deactivate a subscribed shared Feed |
| POST | `/app/api/feeds/:feedId/reactivate` | Access JWT | Manually reactivate a subscribed shared Feed |
| GET | `/auth/logout` | None | Redirect to Access logout URL |
| POST | `/accounts/ClientLogin` | None (validates token) | GReader auth entry point |
| GET/POST | `/reader/*` | API token header | All GReader API endpoints |

Reader routes are also mounted under the FreshRSS-compatible `/api/greader.php` prefix.
Normal and forced manual sync return `{ triggered, eligible, forced, instanceId }` JSON;
`eligible` is a global pre-trigger count, not a per-User count or completion guarantee.
Feed controls require a Subscription but change the shared Feed for all subscribers.
