# Auth Flow

## Overview

No passwords exist anywhere in this system. The management UI is protected by Cloudflare Access
(handles login externally). API tokens for GReader clients are generated through the
Access-protected web UI and can be revoked at any time.

---

## Web UI Auth — Cloudflare Access

Routes under `/app/*`, `/tokens/*`, and `/import` are protected by `accessMiddleware`
(`src/middleware/access.ts`). Cloudflare Access sits in front of the Worker and handles
login entirely — the Worker never sees credentials.

On every authenticated request, Access injects a signed JWT:

```
Cf-Access-Jwt-Assertion: <jwt>
```

The Worker verifies this JWT against Access's public JWKS (fetched from `<iss>/cdn-cgi/access/certs`),
checks audience (`CF_ACCESS_AUD`) and expiry, then extracts the `email` claim.

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

1. Authenticated user visits `/app/access` (Access-protected React page)
2. Enters a token name (e.g. "Current on iPhone") and clicks Generate
3. `POST /app/api/tokens` — uses `generateApiToken` in `src/lib/api-tokens.ts`:
   - Worker generates 32 cryptographically random bytes encoded as a 64-char hex string
   - SHA-256 hashes it and stores the hash in `api_tokens`
   - Returns the **raw token once** (`no-store` JSON) — never stored, logged,
     or returned by any later read (`GET /app/api/tokens` exposes only
     name, created, coarse last-used, and revocation state)
4. User copies raw token into Current's password field (the page also shows
   the FreshRSS connection settings: server URL = this origin, username = email)

### Usage (GReader ClientLogin)

```
POST /accounts/ClientLogin
Body: Email=user@example.com&Passwd=<raw-token>

1. Worker SHA-256 hashes the Passwd value
2. Looks up hash in api_tokens WHERE revoked_at IS NULL
3. On match: returns Auth=<raw-token> (echoed back)
4. All subsequent GReader requests use:
   Authorization: GoogleLogin auth=<raw-token>
5. Each request: hash lookup; last_used_at is refreshed only when older than
   an hour (LAST_USED_RESOLUTION_MS), so "last used" is coarse by design
```

### Revocation

1. User visits `/app/access`, sees tokens with name, created, last used, and state
2. Clicks Revoke, then confirms the named token inline
3. `DELETE /app/api/tokens/:id` sets
   `revoked_at = Date.now()` — ownership verified against `userId`; another
   User's token id returns 404 and is untouched
4. The route loader re-runs and the row shows as Revoked
5. Any subsequent GReader request with that token receives `401 Unauthorized`

---

## Route Summary

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/app` | Cloudflare Access | Token management UI (Access tab) |
| GET | `/app/feeds` | Cloudflare Access | Feed management UI (Feed tab) |
| GET | `/app/api/tokens` | Cloudflare Access | List tokens + connection info (JSON) |
| POST | `/app/api/tokens` | Cloudflare Access | Generate new API token (JSON, raw value once) |
| DELETE | `/app/api/tokens/:id` | Cloudflare Access | Revoke token (JSON) |
| POST | `/app/api/import` | Cloudflare Access | OPML feed import |
| GET | `/auth/logout` | None | Redirect to Access logout URL |
| POST | `/accounts/ClientLogin` | None (validates token) | GReader auth entry point |
| GET/POST | `/reader/*` | API token header | All GReader API endpoints |
