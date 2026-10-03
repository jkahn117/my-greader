# Auth Flow

## Overview

No passwords exist anywhere in this system. The management UI is protected by Cloudflare Access
(handles login externally). API tokens for GReader clients are generated through the
Access-protected web UI and can be revoked at any time.

---

## Web UI Auth — Cloudflare Access

Routes under `/app/*`, `/tokens/*`, `/feeds/*`, and `/import` are protected by `accessMiddleware`
(`src/middleware/access.ts`). Cloudflare Access sits in front of the Worker and handles
login entirely — the Worker never sees credentials.

On every authenticated request, Access injects a signed JWT:

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

Set `DEV_MODE=true` in `.dev.vars` to bypass JWT verification. The middleware injects a
hardcoded dev user (`dev-user-id` / `dev@localhost`) without checking for a JWT header.
This path is gated on `DEV_MODE === 'true'` and never executes in production.

---

## GReader API Auth — API Tokens

The GReader `ClientLogin` protocol uses a username + password POST — browser redirects are not
possible. Cloudflare Access cannot protect these routes. API tokens are the bridge.

### Generation

1. Authenticated user visits `/app/access` (Access-protected)
2. Enters a token name (e.g. "Current on iPhone") and clicks Generate
3. `POST /tokens/generate` delegates to `createApiTokenLifecycle()`:
   - The module generates 32 cryptographically random bytes encoded as a 64-char hex string
   - It SHA-256 hashes the token and stores only the hash in `api_tokens`
   - The handler returns the raw token once in the htmx response fragment; it is never stored
4. User copies raw token into Current's password field

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

1. User visits `/app/access`, sees active tokens with name + last used date
2. Clicks Revoke
3. `DELETE /tokens/:id` asks the API Token module to set `revoked_at`. The module verifies ownership against `userId`.
4. htmx removes the row from the UI via `outerHTML` swap
5. Any subsequent GReader request with that token receives `401 Unauthorized`
6. Weekly cleanup removes tokens that have been revoked for at least seven days, using the same module policy.

The API Token module owns generation, hashing, lookup, usage recording, listing,
revocation, and retention. HTTP adapters still own Cloudflare Access checks,
header and form parsing, rate limiting, logging, and wire responses.

---

## Route Summary

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/app` | Cloudflare Access | Redirect to the Metrics tab |
| GET | `/app/metrics` | Cloudflare Access | D1 and Analytics Engine metrics |
| GET | `/app/timeline` | Cloudflare Access | Durable Cycle Run and Feed-attempt history |
| GET | `/app/feeds` | Cloudflare Access | Subscription and Feed management (Feed tab) |
| GET | `/app/access` | Cloudflare Access | API Token management (Access tab) |
| POST | `/tokens/generate` | Cloudflare Access | Generate new API token |
| DELETE | `/tokens/:id` | Cloudflare Access | Revoke token |
| POST | `/import` | Cloudflare Access | OPML Feed import |
| POST | `/feeds/sync` | Cloudflare Access | Start a normal manual Cycle Run for eligible Feeds |
| POST | `/feeds/sync/force` | Cloudflare Access | Start a forced Cycle Run for all active subscribed Feeds |
| POST | `/feeds/:id/deactivate` | Cloudflare Access | Manually deactivate a subscribed Feed |
| POST | `/feeds/:id/reactivate` | Cloudflare Access | Manually reactivate a subscribed Feed |
| GET | `/auth/logout` | None | Redirect to Access logout URL |
| POST | `/accounts/ClientLogin` | None (validates token) | GReader auth entry point |
| GET/POST | `/reader/*` | API token header | All GReader API endpoints |
