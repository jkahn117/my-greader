# Migration architecture record

Issue [#18](https://github.com/jkahn117/my-greader/issues/18) used this document to define the migration's intended ownership and dependency direction. The cutover is complete on the `next` branch.

[`architecture.md`](architecture.md) is the only description of the current implementation. It records the shipped module boundaries, D1 model, polling and retry contract, retention policy, observability backend, authentication, and retained compatibility fields.

The final implementation kept the existing deep modules where moving files would not improve ownership. Directory names are not the contract. The enforced boundaries are:

- HTTP and Cloudflare adapters parse protocol or runtime concerns and delegate.
- Domain modules own selection, persistence policy, and reconciliation.
- Modules use D1 directly rather than a repository abstraction.
- Observability delivery stays outside domain interfaces and cannot change durable outcomes.
- GReader compatibility remains covered through Worker HTTP tests. Polling reliability remains covered through the `FeedPoller` and Workflow execution seams.

The original target layout and migration decisions remain in the issue history. Do not use them as a second current architecture document.
