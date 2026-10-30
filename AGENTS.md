# My GReader

A personal RSS aggregator on Cloudflare Workers exposing a Google Reader-compatible API. Humans start with [README.md](README.md); this file routes agent work.

## Working rules

- Use pnpm for package management.
- After any code change, run `pnpm lint`. Run `pnpm test` to verify behavior changes.
- Preserve Google Reader API compatibility. Existing clients depend on its protocol behavior.
- Log Feed failures with enough context for users to troubleshoot. Expose diagnostics in the dashboard where practical.
- For architecture changes, update `docs/architecture.md`. For deployment changes, update `README.md`.

## Read by task

- Domain behavior or terminology, including specs and tests: read [CONTEXT.md](CONTEXT.md) before exploring or naming concepts. Keep vocabulary changes in `CONTEXT.md`.
- Module boundaries, data flow, or stack integration: read [architecture](docs/architecture.md).
- Code changes: read [coding style](docs/agents/style.md) for TypeScript, validation, logging, CSS, and comments.
- Authentication: read [auth flow](docs/auth-flow.md) before changing Access JWT verification or the API Token lifecycle.
- Reader endpoints or client behavior: read [GReader API](docs/reference/greader-api.md).
- Design decisions: read the relevant [decision entries](docs/decisions.md) before changing an area or revisiting a choice. Record short, dated entries in `docs/decisions.md` rather than separate ADR files.
- Deployment: read [README.md](README.md) before changing configuration or deployment procedures.
- GitHub issues and specs: read [issue tracker guidance](docs/agents/issue-tracker.md) before fetching, publishing, or triaging work.

Current runtime facts belong in architecture, decision rationale in the decision record, and operator procedures in README and its runbooks. Consult deferred research only for its named question.
