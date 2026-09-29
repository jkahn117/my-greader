# Target architecture for next

This is the target layout for the migration in [issue #18](https://github.com/jkahn117/my-greader/issues/18), not a description of the deployed implementation. [Current architecture](architecture.md) describes the existing code.

The directory layout records ownership. It does not require moving every file before behavior changes, creating empty directories, or introducing a factory for each folder. Keep useful existing implementation and migrate it with its tests.

## Target layout

```text
src/
  index.tsx                Worker composition and route registration
  domain/
    polling/               Polling, Feed health, execution ownership
    subscriptions/         Subscription and Folder lifecycle
    items/                 Item identity, Item State, retention
    stream/                Query-only Stream scope and pagination
    tokens/                API Token lifecycle
    activity/              Dashboard projections and polling history
  adapters/
    greader/               GReader parsing and wire formatting
    dashboard/             Management HTTP handlers and JSX views
    cloudflare/            Cron, Workflow execution, Access verification
    observability/         Structured logging and Analytics Engine
  db/
    schema.ts              D1 schema
  styles.css               Dashboard stylesheet source
  types/                   Runtime and framework declarations

test/                      Behavior tests, organized by domain/protocol
public/                    Static assets and generated CSS
drizzle/                   Existing migration history
```

The migration directory remains at the repository root under its existing name. Moving applied migrations into `src/db/` adds deployment risk without improving domain ownership. The Stream module is explicit here because the agreed migration preserves its query-only responsibility; it is not folded into Item State mutations.

## Module ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| Polling | Eligibility, Backoff, parsing and ingestion coordination, Feed health transitions, initial backload policy, per-Feed execution ownership, attempt completion, Cycle Run reconciliation | Workflow step placement, HTTP responses, concrete logging tooling |
| Subscriptions | Canonical Feed registration, subscribe/unsubscribe/edit, Folder changes, Subscription queries and ownership checks | Polling execution, global Feed health transitions, GReader serialization |
| Items | Item identity rules, Item State transitions, scoped bulk state changes, Item and Item State retention | Stream pagination, GReader tag syntax, scheduling |
| Stream | User-scoped Item queries, Feed reference resolution for queries, supported Stream scopes, ordering and continuation semantics | Item State mutations, JSX, caller-authored SQL fragments |
| API Tokens | Generation and hash-only storage, active-token lookup, usage policy, revocation, retention | Header parsing, ClientLogin formatting, Access JWT verification |
| Activity | D1-backed dashboard projections, Item attribution to attempts and Cycle Runs, explicit legacy/unattributed history, bounded history reads | Execution state writes, guessing attribution from timestamp windows, rendering |

A table may be read by several modules, but each invariant has an owner. Polling coordinates atomic ingestion completion, including Item insertion and attribution; Items owns identity and retention rules. Do not split one required transaction into independent module commits merely to match this table.

Subscription operations and polling eligibility both use canonical Feed data. Feed health mutation belongs to Polling even when a management handler initiates it. User authorization for such an operation must be established before a shared Feed changes.

Stream scope concepts must agree between read queries and Item State mutations. Keep database predicates internal. Resolve the smallest shared representation during implementation rather than creating a generic query framework.

## Adapter ownership

- **GReader:** request validation, accepted prefixes and parameter forms, Item ID wire normalization, response shape and status codes. Token-header parsing belongs here; validation delegates to API Tokens.
- **Dashboard:** management requests, htmx fragments, JSX, presentation formatting, and delivery of already authorized domain results. Queries and state-transition rules stay in domain modules.
- **Cloudflare:** scheduled entry points, Workflow steps, binding lifetimes, retry configuration, and Cloudflare Access verification. Register dependencies at the Worker composition point or inside the appropriate execution context.
- **Observability:** map domain outcomes to structured logs and optional metrics. Keep the existing Analytics Engine read adapter's query dialect, physical column mapping, and degradation behavior here.

Activity projections use D1 as the durable source of execution history. Compose optional Analytics Engine projections outside the domain implementation, at the dashboard adapter. This keeps domain modules independent of concrete observability tooling.

## Dependency direction and interfaces

```text
Worker composition
  -> protocol and runtime adapters
       -> domain module interfaces
            -> D1 schema and database access
            -> narrow external dependencies where behavior varies

Domain outcomes
  -> observer adapter
       -> logs and Analytics Engine
```

- Domain modules do not import Hono contexts, JSX, Workflow classes, or observability tooling.
- Modules accept D1 directly. A single store does not justify a repository abstraction.
- Keep the existing Feed transport, clock, and observer seams where they earn their keep. Tests and callers use the same module interface.
- Runtime execution concerns remain in Workflow steps. Domain completion remains one retry-safe contract, even if several private functions implement it.
- Keep helper implementation near its owner. A shared utility must have actual reuse; `lib/` must not become the default location for code without an owner.
- Do not create one public interface per internal function. A directory can contain private implementation files without exposing them to callers.
- Keep shared runtime declarations small. Domain types belong with the module that defines their meaning.

Detailed function interfaces are not decided by this layout. The execution identity, D1 atomicity, retention, and migration decisions listed in issue #18 remain gates before implementation of the affected behavior.

## Mapping from the current implementation

| Current area | Target ownership |
| --- | --- |
| `src/feed/poll.ts` | Polling module, preserving its existing depth |
| `src/feed/subscriptions.ts` | Subscriptions module |
| `src/feed/stream.ts` | Stream module, with SQL fragments hidden behind its interface |
| `src/feed/analytics.ts` | Observability read adapter |
| `src/handlers/greader/` | GReader adapter; Item State policy moves to Items |
| `src/handlers/feeds_ui.tsx` and `src/handlers/import.tsx` | Dashboard adapter; delegate Subscription and Feed health changes |
| `src/handlers/metrics.tsx` and `src/handlers/timeline.tsx` | Dashboard adapter; D1 projections move to Activity |
| `src/views/` | Dashboard adapter presentation implementation |
| `src/workflows/feed_polling.ts` | Cloudflare adapter; domain selection and completion policy move to Polling |
| `src/handlers/cron.ts` | Cloudflare adapter; cleanup policy moves to Items and API Tokens |
| `src/handlers/tokens.tsx` and `src/middleware/token.ts` | Dashboard/GReader adapters delegating to API Tokens |
| `src/middleware/access.ts` | Cloudflare adapter, retaining the existing Access authentication model |
| `src/lib/` | Relocate domain-specific helpers to their owners; retain only genuinely shared implementation |

## Migration discipline

Follow the stages and acceptance gates in issue #18. Move implementation when its responsibility changes, not in a preliminary repository-wide rename. Avoid maintaining two independent policy implementations during transition.

Keep existing tests through the approved seams:

1. Worker HTTP for GReader compatibility, authentication, User isolation, and dashboard behavior.
2. FeedPoller for ingestion and durable outcomes against local D1 with controlled transport and time.
3. Workflow execution for retries, overlap, and interruption, verified through persisted outcomes.

Adding folders does not justify additional test seams. Keep migration fixtures and compatibility checks until the corresponding rollout and recovery gates pass.

At completion, update the current architecture document to describe the implemented layout. Retain this document as the design record or replace it with a pointer; avoid two conflicting descriptions of the current system.
