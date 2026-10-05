## Problem Statement

The primary User manages a personal RSS deployment and reads through Current on iOS. The management interface is plain, cramped and organized around backend Cycle Runs rather than the User's questions. It does not make effective use of retained Feed attempts, explicit Feed health and Item State.

The User needs an at-a-glance view of both reading activity and health, a listing of Feeds with current status, an evidence-based Feed diagnostic page, deeper reading metrics and simple access management. Current's Mark Read, Release and expiration mappings remain unverified, so the interface must not claim to measure actual reading intent.

## Solution

Replace the management dashboard with React built by Vite, TanStack Router and actual shadcn components. Keep Hono, existing authentication, Feed modules, D1, polling and the Google Reader API.

Provide Overview, Feeds, Reading and Access. Overview balances reading and Feed health. Feeds opens a full Feed detail page with history across Cycle Runs, grouped errors and expandable results. Reading expands the known state metrics; Access remains a small API Token management page.

Use the accepted graphite navigation, cool gray surfaces, white cards, blue actions and violet reading charts. The Overview health card is named Feed health, not Deployment health. Reading and Feed health appear above Needs attention. New Items over the past seven days replaces Currently starred in the Overview summary and sits immediately left of Items marked read.

## User Stories

1. As the primary User, I want an Overview of reading activity and deployment health, so that I can understand the deployment without visiting every page.
2. As the primary User, I want consistent Overview, Feeds, Reading and Access navigation, so that I know where each task belongs.
3. As the primary User, I want the number of my subscribed Feeds and their active or deactivated status, so that I understand the size of the deployment.
4. As the primary User, I want New Items over the past seven days immediately left of Items marked read, so that I can see incoming activity beside client-reported reading state.
5. As the primary User, I want the New Items metric scoped to my Subscriptions, so that Items from other Users do not inflate my overview.
6. As the primary User, I want an Items marked read trend on Overview, so that I can see recent activity at a glance.
7. As the primary User, I want a compact top-Feed marked-read summary, so that I can see which Feeds I have recently engaged with according to client state.
8. As the primary User, I want a Feed health summary beside reading activity, so that neither operational issues nor reading dominates the landing page.
9. As the primary User, I want Needs attention below reading and Feed health, so that the main page remains an overview rather than an error console.
10. As the primary User, I want affected Feeds linked directly to their details, so that I can investigate without locating their Cycle Runs first.
11. As the primary User, I want rate-limited checks separated from failed checks, so that ongoing HTTP 429 responses are visible.
12. As the primary User, I want deliberate skips and manual pauses separated from failures, so that normal operating decisions do not look broken.
13. As the primary User, I want the latest polling activity and its lifecycle shown accurately, so that I can recognize running, completed, empty or missing activity.
14. As the primary User, I want ordinary unchanged and not-modified checks treated as successful checks, so that a quiet publisher does not appear broken.
15. As the primary User, I want a list of all subscribed Feeds with current status, so that I can review the whole collection.
16. As the primary User, I want to search Feeds and filter by status or Folder, so that I can find relevant Subscriptions quickly.
17. As the primary User, I want current health, last successful check, last new Item and next eligibility in Feed listings, so that I can distinguish availability from publication frequency.
18. As the primary User, I want a Feed row to open a full Feed detail page, so that investigation is centered on the Feed I care about.
19. As the primary User, I want a plain-language summary of a Feed's current problem, so that I understand what is happening before inspecting individual attempts.
20. As the primary User, I want to see consecutive problem checks and the first observed problem, so that I know how persistent an issue is.
21. As the primary User, I want checks counted independently of elapsed system Cycle Runs, so that Backoff does not exaggerate a failure streak.
22. As the primary User, I want a chronological outcome strip across a Feed's checks, so that I can see failures, persistence and recovery.
23. As the primary User, I want grouped HTTP, network and parse errors over a labeled window, so that repeated causes are visible without reading every row.
24. As the primary User, I want timestamped results with expandable diagnostics, so that I can inspect the evidence behind a summary.
25. As the primary User, I want parser fallback, failure and not-attempted states distinguished, so that I can tell what stage polling reached.
26. As the primary User, I want copyable full Feed-attempt IDs and secondary Cycle Run links, so that I can correlate dashboard evidence with logs.
27. As the primary User, I want current Backoff and next eligibility displayed, so that I know how the system is responding to rate limiting.
28. As the primary User, I want automatic and manual Deactivation reasons distinguished, so that I understand why polling stopped.
29. As the primary User, I want supported Deactivation and reactivation actions available, so that I can manage Feed health without changing the polling policy.
30. As the primary User, I want backload completion and legacy uncertainty preserved, so that inferred history is not presented as a precise fact.
31. As the primary User, I want unavailable or expired history distinguished from zero activity, so that missing records do not look like success.
32. As the primary User, I want actual Item attribution preserved in diagnostic results, so that Items are not assigned to Cycle Runs merely by timestamp.
33. As the primary User, I want a separate Reading page with daily and per-Feed metrics, so that I can explore beyond the Overview summary.
34. As the primary User, I want reading metrics labeled as marked-read state, so that they do not imply verified completion or release intent.
35. As the primary User, I want receipt-time and retention limitations explained briefly, so that offline sync and state changes do not mislead me.
36. As the primary User, I want useful time-window controls and explicit timezone labels, so that displayed totals and dates are understandable.
37. As the primary User, I want Current action research deferred without blocking this dashboard, so that known information can be useful now.
38. As the primary User, I want a simple list of named API Tokens and coarse last observed use, so that I can manage connected clients.
39. As the primary User, I want to generate and revoke API Tokens, so that I can connect Current and remove old access.
40. As the primary User, I want a newly generated API Token shown only once and never redisplayed, so that credentials remain protected.
41. As the primary User, I want Current connection instructions available on Access, so that I can set up a device without hunting through documentation.
42. As the primary User, I want OPML import and existing Subscription management preserved, so that the redesign does not remove working capabilities.
43. As the primary User, I want normal sync and explicitly secondary forced sync, so that a convenient control does not bypass eligibility accidentally.
44. As the primary User, I want browser reloads and direct links to work on detail pages, so that I can return to the same Feed investigation.
45. As the primary User, I want responsive layouts and keyboard-accessible interactions, so that I can use the dashboard on desktop or mobile.
46. As the primary User, I want loading, empty, unavailable and failure states explained, so that an unconfigured or partially failing deployment remains usable.
47. As the primary User, I want the main dashboard to work without Analytics Engine, so that optional analytics failures do not hide D1 health or reading state.
48. As the primary User, I want Current's Google Reader sync unchanged, so that improving management does not break my reading client.

## Implementation Decisions

- Use React, Vite and TanStack Router for the management frontend. Use route loading and plain fetch initially. Do not add TanStack Query, TanStack Start, Astro or a second deployment as part of this feature.
- Use real shadcn components for navigation, summaries, badges, tables, inputs, dropdowns, disclosures and charts. Use their accessibility behavior rather than reproducing it with custom controls. Treat sorting and filtering as application behavior, not functionality automatically provided by Table.
- Keep the accepted visual palette. Use blue for actions and ingestion, violet for reading, amber for actionable warnings and red for failures or automatic Deactivation. Normal Backoff and unchanged checks remain neutral. Do not rely on color alone.
- Overview summary order is Feed count, New Items in the past seven days, Items marked read in the past seven days, and Feeds needing attention. Do not include Currently starred in this summary. It may remain a supporting Reading metric without becoming the focus of this iteration.
- The Overview main-content order is reading and Feed health side by side, followed by a compact Needs attention list. On small screens stack these in the same order. Rename the misleading Deployment health card to Feed health because it describes polling outcomes for Feeds, not infrastructure telemetry.
- The Feeds page owns the complete Subscription listing with current status, search and status/Folder filtering. Row selection opens full Feed detail. Keep Cycle Run history secondary to the Feed-centered workflow.
- Preserve the approved Feed detail design: plain-language problem summary, current Backoff and eligibility, separate successful-check and new-Item timestamps, backload state, check history, structured error aggregation and expandable results. Show current Feed state separately from historical attempt facts.
- Hono exposes same-origin authenticated dashboard JSON reads and mutations. Keep protocol parsing in thin handlers. Shared response types cover Overview, Subscription summaries, Feed history/error groups, Reading summaries and API Token management. Incoming identifiers, windows, pagination, filters and mutation inputs are validated. Do not couple responses to D1 physical rows or return backend credentials to the browser.
- Reuse the Activity module for bounded dashboard projections and extend its factory interface for Overview, Feed-specific paginated history/error aggregates and per-Feed reading state. Reuse Subscriptions for listing/current Feed state, Polling for health transitions and sync eligibility, Analytics for optional aggregates, and the API Token lifecycle for access management. No repository adapter or duplicate business rules in React.
- New Items over the past seven days counts distinct retained Items by ingestion time in the authenticated User's current Subscriptions, including deactivated subscribed Feeds. Change the existing global dashboard aggregate for this metric rather than labeling a global count as personal. Do not sum only the top active publishers or only recent Cycle Runs.
- Seven-day count windows use the past seven elapsed days through the current time. Daily charts use the configured display timezone, fill missing dates with zero, and preserve partial boundary days rather than dropping data to force seven buckets. Totals, per-Feed breakdowns and captions must use consistent windows and scope.
- Marked-read metrics use the known Item State semantics: current read=true rows grouped by their latest server receipt timestamp, with unread clearing the timestamp and retention potentially removing rows. Repeated mark-read can overwrite it. Do not silently turn this into an event ledger. Per-Feed Reading metrics join existing Item State, Items and Subscriptions; no new signal from Current is needed.
- Do not present newly fetched and marked-read counts as a completion ratio: they are not the same cohort. Do not infer reading duration, release or expiration from read state, age, batch size or request timing.
- Feed health aggregation uses durable attempts. HTTP 429 is rate_limited, not failed, and does not increment the existing persisted consecutive-error counter. Derive displayed problem/rate-limit streaks from retained terminal checked attempts. A successful new_items, unchanged or not_modified attempt ends a problem streak; skipped attempts neither count as checks nor create a failure. In-progress work is explicit, not a success or failure. If the beginning of a streak is outside retained history, report a lower bound or unknown start rather than a precise invented duration.
- Group problems by structured HTTP status and network/parse class with an explicit window. Explain confirmed evidence separately from possible causes. A 403 does not prove Cloudflare blocking, a parse failure does not prove malformed publisher XML, and a 404 does not prove the Feed moved.
- Feed history queries are independently scoped to the selected Feed, bounded, stably ordered and paginated. Do not reuse a projection limited to the latest global Cycle Runs, which can omit backed-off Feeds. Retain the current 90-day operational-history policy and explicit legacy/expired attribution uncertainty. Add additive query indexes if required; no new event store or diagnostic response-body schema is required.
- Maintain the existing public diagnostic safety boundary. Expose classified diagnostics and approved safe detail, not arbitrary stored response text or credentials. Copy identifiers in full even when abbreviated visually. Preserve exact Item-to-attempt attribution; never infer it from timestamps.
- Keep Cloudflare Access authentication and User ownership checks for all management reads and mutations, despite there being one primary User. Preserve existing mutation security and reject unauthorized access rather than letting client routing act as protection. API Token secrets are returned only on generation, never in ordinary reads or logs; last use is coarse, updated at most hourly.
- Preserve OPML import, supported Subscription management, manual Feed health controls, normal/forced sync and API Token workflows while replacing htmx dashboard interactions. Refresh affected route data after successful mutations. Keep token-authenticated Google Reader routes and response semantics unchanged.
- Keep one Worker deployment serving the management client and Hono backend unless build integration requires a documented change. Make deep-link reloads work without the static client fallback intercepting JSON endpoints or Google Reader routes. Update architecture/decision documentation when implementing the frontend migration and deployment documentation if build/deploy steps change.
- D1 remains authoritative for core dashboard data. Optional Analytics Engine panels degrade independently and label their time windows. A failure to load one optional panel must not hide the rest of Overview.
- Complete responsive, keyboard, focus, loading, empty, unavailable-history and error states during implementation. Keep diagnostics discoverable and useful without requiring hover. Avoid raw exception output in the UI.

## Testing Decisions

- Proposed primary test seam is the public authenticated Worker request/response boundary backed by D1. Exercise dashboard JSON reads and mutations using realistic seeded records, then assert responses and durable effects. Prefer this existing high seam over unit tests tied to React components, SQL text, private helpers or method-call counts.
- Follow the existing management-route tests for imports, health controls, metrics and history; the Google Reader tests for ownership and compatible no-ops; API Token tests for one-time generation and revocation; polling-outcome tests for classified failures/Backoff; and retention tests for unavailable attribution. These are prior art, not separate replacement harnesses.
- At that boundary test the behavior of the Activity, Subscriptions, Polling and API Token modules composed through dashboard handlers. Verify User isolation even with shared canonical Feeds and arbitrary Feed/Item identifiers.
- Seed a subscribed deactivated Feed, another User's Feed, old/new Items, sparse read dates, repeated read updates, unread transitions and retained starred Items. Assert New Items counts use the correct Subscription scope, seven-day boundary and ingestion time; read-state counts and per-Feed totals have consistent semantics and timezone handling. Test partial daily boundaries and zero-filled dates without fixing expected output to private SQL.
- Seed successive 429s without an incremented failure counter, permanent and transient failures, successful unchanged/304 checks, skipped attempts, running attempts and recovery. Assert separate outcome counts, check-based streaks, safe diagnostics, grouped errors and honest missing-history behavior.
- Test pagination/stable ordering with tied timestamps, sparse backed-off Feed history beyond the latest global Cycle Runs, legacy state and expired attribution. Ensure history remains bounded and Item attribution is never reconstructed by a time window.
- Test authorized and unauthorized mutation behavior, normal versus forced sync, import duplicates, API Token secret exposure and revocation, plus failure responses. Preserve existing Google Reader compatibility coverage and production-auth checks throughout migration.
- Add a small browser acceptance layer only for behavior JSON cannot prove: Overview card naming/order, navigation and deep-link reload, Feed listing filters/row selection, result expansion, copy controls, Reading breakdowns, Token actions, mobile stacking and keyboard/focus behavior. Prefer user-visible labels and roles over CSS selectors, snapshots of implementation markup or isolated component internals. Use real Worker endpoints for representative journeys; do not establish an independently mocked dashboard contract.
- Test unavailable Analytics Engine separately from D1 failure. Confirm core Overview remains available, failure text is safe and empty/unavailable states do not fabricate zero activity or health claims.
- Run lint, existing Worker tests, type checking and production build. Check that the shadcn plugin loads; do not enable new lint policies or presets implicitly. Add chosen design-system rules only by explicit agreement.

## Out of Scope

- Running the Current read/release/expiration experiment, or waiting for its results. Issue #41 tracks it independently and is not a blocker.
- Actual reading-completion, release, skip, expiration or duration analytics without a verified explicit signal from Current.
- Reworking Item State into an append-only reading-event ledger, changing reading timestamps or extending Google Reader semantics for analytics.
- Changing polling thresholds, Backoff policy, ownership, retry identity, Item identity, retention durations or Google Reader client contracts.
- Infrastructure observability tooling, health scores or diagnosing WAF/provider blocking without retained evidence. The Feed health card is not an infrastructure monitoring dashboard.
- New arbitrary response-body/header storage, automated Feed URL migration or automatic remediation based on guessed error causes.
- TanStack Query, TanStack Start, Astro, a separate frontend hosting service or a wholesale backend rewrite.
- Recreating Current's reading interface, unread-inbox pressure or a full content reader in the management dashboard.
- Complex access administration, new authentication systems or multi-User administration. Existing User isolation remains mandatory.

## Further Notes

- This spec synthesizes the accepted design and latest corrections. The local review board is `docs/design/dashboard-directions.svg`, revision 05; its values are illustrative, not account data. The accompanying direction and reading-signal notes explain the rationale. Preserve these review artifacts with the implementation so they do not depend on an uncommitted local file.
- The final Overview corrections are authoritative over earlier boards: Feed health naming; reading/health above Needs attention; New Items replaces Currently starred and sits left of Items marked read.
- React + Vite + TanStack Router is agreed. TanStack Query remains deferred. The runtime is still Hono JSX/htmx until implementation occurs.
- Issue #41: https://github.com/jkahn117/my-greader/issues/41. Distinguishing Current actions may later justify richer Reading metrics, but this feature must ship honestly with current information.
- Test-seam confirmation gate: before implementation, confirm with the User that Worker request/D1 behavior tests plus a minimal browser acceptance layer match expectations. This is the only confirmation requested by the spec process; do not reopen already-settled design and stack choices as an interview.
