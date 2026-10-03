# My GReader

A personal RSS aggregator on Cloudflare Workers exposing a Google Reader-compatible API.

## Working rules

- Use pnpm for package management.
- After any code change, run `pnpm lint`. Run `pnpm test` to verify behavior changes.
- Preserve Google Reader API compatibility. Existing clients depend on its protocol behavior.
- Log feed failures with enough context for users to troubleshoot. Expose diagnostics in the dashboard where practical.
- For architecture changes, update `docs/architecture.md`. For deployment changes, update `README.md`.

## Before working

- Domain behavior: read [domain guidance](docs/agents/domain.md) before exploring or changing behavior, or naming concepts in issues, specs, proposals, or tests. It governs terminology and ADR use.
- Code changes: read [coding style](docs/agents/style.md) for TypeScript, validation, logging, CSS, and comments.
- Module boundaries or data flow: read [architecture](docs/architecture.md) for module ownership, persistence, polling, metrics, and observability boundaries.
- Stack or client integration: read [architecture overview](docs/agents/architecture-overview.md) for platform choices and Current's FreshRSS connection mode.
- Issues and specs: read [issue tracker guidance](docs/agents/issue-tracker.md) before fetching, publishing, or triaging GitHub work.

## Task references

- Authentication: read [auth flow](docs/auth-flow.md) when changing Access JWT verification or the API Token lifecycle.
- API compatibility: read [GReader API](docs/reference/greader-api.md) when implementing or reviewing endpoints or client behavior.
- Design decisions: consult the [ADR index](docs/decisions.md) before revisiting a technical choice.
- Deployment: read [README.md](README.md) before changing configuration or deployment procedures.
