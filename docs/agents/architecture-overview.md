# Architecture overview

## Stack

- **Runtime**: Cloudflare Workers with static assets (no Pages)
- **Auth**: Cloudflare Access (JWT verification, no sessions/KV)
- **Router**: Hono with JSX renderer
- **UI**: htmx (vendored, no CDN), Tailwind CSS v4, shadcn-aesthetic via CSS (no React)
- **Database**: Cloudflare D1 (SQLite), Drizzle ORM (schema + migrations + queries)
- **Polling**: Cloudflare Workflows with durable Cycle Runs and per-Feed attempts in D1
- **Metrics**: D1 for durable dashboard projections; Workers Analytics Engine for optional trends
- **Feed parsing**: rss-parser with a lenient linkedom fallback

## Dual concerns

The Worker serves two distinct concerns:

1. **Management UI** — Cloudflare Access protects Metrics, Feed, Timeline, and Access tabs, including API Token and Feed controls
2. **GReader API** — the RSS backend that Current connects to, authenticated via long-lived API Tokens

## FreshRSS note

Current connects to this backend using its **FreshRSS** sync option (custom server URL). The backend speaks the Google Reader API protocol — it does not run FreshRSS.

## Further reading

- [Architecture](../architecture.md)
- [Auth flow](../auth-flow.md)
- [GReader API reference](../reference/greader-api.md)
