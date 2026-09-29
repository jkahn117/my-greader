# My GReader

A personal RSS aggregator on Cloudflare Workers exposing a Google Reader-compatible API.

- **Package manager**: pnpm (never npm/yarn)
- **Quality gate**: `pnpm lint` (oxlint) — run after any code change
- **Tests**: `pnpm test` (vitest with Cloudflare Workers pool) — live in `test/`

## Core Tenets

- Google Reader API must match expectation. Clients depend on a known implementation, we cannot modify.
- Understanding feed errors or issues is vital. These should be, at minimum, logged in an easily discoverable manner so that the user can troubleshoot. Secondarily, expose via Dashboard.
- Docs need to stay up-to-date. A change that impacts architecture should include an update to `docs/architecture.md`; a change to deployment should end up in `README.md`.

## Architecture

Feed-level business logic lives in five deep modules under `src/feed/`, each
behind a small factory interface. Handlers and the Workflow are thin adapters
that parse protocol concerns and delegate.

| Module | Responsibility |
|--------|---------------|
| `poll.ts` | Fetch, parse, store items; interval backoff; error/deactivation |
| `subscriptions.ts` | Canonical feed upsert; subscribe/unsubscribe/edit; list/get |
| `item-state.ts` | Per-User read/star transitions, read timestamps, ownership, scoped mark-all |
| `stream.ts` | User-scoped Stream resolution and paginated Item queries |
| `analytics.ts` | Analytics Engine read adapter (SQL, column layout, row mapping) |

Modules accept D1 directly (no repository adapter — single store).  Observability
tooling (`@workers-powertools`) never crosses the module seams; observer interfaces
carry domain event payloads.

See [`docs/architecture.md`](docs/architecture.md) for the full overview.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: read `CONTEXT.md` and relevant ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Project conventions

- [Coding style](docs/agents/style.md) — TypeScript, Valibot, logging, commenting
- [Architecture overview](docs/agents/architecture-overview.md) — stack, deep-module design

## Reference docs

- [Architecture](docs/architecture.md) — stack, data model, deep modules, polling, metrics, auth
- [Auth flow](docs/auth-flow.md) — Cloudflare Access JWT + API token lifecycle
- [GReader API](docs/greader-api.md) — endpoint list, FreshRSS compatibility
- [Decisions](docs/decisions.md) — rationale for key technical choices
