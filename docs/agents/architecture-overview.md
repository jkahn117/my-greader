# Architecture overview

## Stack

- **Runtime**: Cloudflare Workers with static assets (no Pages)
- **Auth**: Cloudflare Access (JWT verification, no sessions/KV)
- **Router**: Hono with JSX renderer
- **UI**: htmx (vendored, no CDN), Tailwind CSS v4, shadcn-aesthetic via CSS (no React)
- **Database**: Cloudflare D1 (SQLite), Drizzle ORM (schema + migrations + queries)
- **Feed parsing**: rss-parser

## Dual concerns

The Worker serves two distinct concerns:

1. **Auth + token management UI** — Cloudflare Access protects the UI; session-protected pages for generating and revoking API tokens
2. **GReader API** — the RSS backend that Current connects to, authenticated via long-lived API tokens

## FreshRSS note

Current connects to this backend using its **FreshRSS** sync option (custom server URL). The backend speaks the Google Reader API protocol — it does not run FreshRSS.

## Further reading

- [Architecture](docs/architecture.md)
- [Auth flow](docs/auth-flow.md)
- [GReader API](docs/greader-api.md)
