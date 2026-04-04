# RSS Reader Backend

A personal RSS aggregator backend hosted on Cloudflare, exposing a Google Reader-compatible API for use with the Current RSS reader app (and any other GReader client).

## Stack

- **Runtime**: Cloudflare Workers with static assets (no Pages)
- **Auth**: Cloudflare Access (JWT verification, no sessions/KV)
- **Router**: Hono with JSX renderer
- **UI**: htmx (vendored, no CDN), Tailwind CSS v4, shadcn-aesthetic via CSS (no React)
- **Database**: Cloudflare D1 (SQLite), Drizzle ORM (schema + migrations + queries)
- **Feed parsing**: rss-parser
- **Validation**: Zod v4 for all API input validation
- **Logging**: Structured JSON logger (`src/lib/logger.ts`) — captures request context, user ID, etc.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — project structure, D1 schema, KV namespaces, cron trigger
- [`docs/auth-flow.md`](docs/auth-flow.md) — magic link flow, session management, API token lifecycle
- [`docs/greader-api.md`](docs/greader-api.md) — GReader endpoint list, FreshRSS compatibility approach
- [`docs/decisions.md`](docs/decisions.md) — rationale behind key technical choices

## Quick orientation

The Worker serves two distinct concerns:

1. **Auth + token management UI** — Cloudflare Access protects the UI; session-protected pages for generating and revoking API tokens
2. **GReader API** — the RSS backend that Current connects to, authenticated via long-lived API tokens

Current connects to this backend using its **FreshRSS** sync option (custom server URL). The backend speaks the Google Reader API protocol — it does not run FreshRSS.

## Coding Style

- ONLY use spaces
- All file types indent by **two spaces**
- Always prefer Tailwind v4 CSS conventions for using CSS variable names
- Always Typescript, strict mode
- Utilize comments to clearly and concisely explain
- Only use `pnpm` for package management
- Use **Zod v4** (`import { z } from 'zod'`) for all API input validation (query params, form bodies)
- Use the structured logger (`import { createLogger } from '../lib/logger'`) — always pass request context (rayId, userId, path) via `logger.child()`; never use `console.log` directly in handlers

## Communication

- You are always concise in responses, focus on code (where appropriate) over long-winded descriptions
- Be critical of design and architecture trade-offs, we want to optimize for efficiency and understandability