# My GReader

A personal RSS aggregator on Cloudflare Workers exposing a Google Reader-compatible API.

- **Package manager**: pnpm (never npm/yarn)
- **Quality gate**: `pnpm lint` (oxlint) — run after any code change
- **Tests**: `pnpm test` (vitest with Cloudflare Workers pool)

## Project conventions

- [Coding style](docs/agents/style.md) — TypeScript, Zod, logging
- [Architecture overview](docs/agents/architecture-overview.md) — stack, dual-concern design

## Reference docs

- [Architecture](docs/architecture.md) — D1 schema, KV namespaces, cron trigger
- [Auth flow](docs/auth-flow.md) — magic links, sessions, API token lifecycle
- [GReader API](docs/greader-api.md) — endpoint list, FreshRSS compatibility
- [Decisions](docs/decisions.md) — rationale for key technical choices
