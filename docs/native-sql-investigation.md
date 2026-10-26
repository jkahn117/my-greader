# Native unified SQL investigation

## Decision

**Platform support: go. Migration now: no-go pending maintainer verification.** Cloudflare documents an Analytics SQL Worker binding, and its dataset guide explicitly includes Workers Analytics Engine datasets. The binding can replace the current HTTP query transport without changing Analytics Engine writes. The repository does not establish that this Cloudflare account has the required Analytics Engine entitlement or that production queries return acceptable data. Keep the existing HTTP adapter and `CF_API_TOKEN` requirement unchanged until the maintainer verifies both.

This is a transport change only. D1 remains authoritative for Cycle Runs, Feed attempts, Feed health, and User-visible operational history. Analytics Engine remains optional, and a query failure must continue to degrade only the analytics panel.

## What the Worker uses today

`src/lib/metrics.ts` writes to the `ANALYTICS` Workers Analytics Engine dataset binding configured in `wrangler.jsonc` as `rss_reader_metrics`. It emits `feed_new_articles`, `feed_parse_duration_ms`, and `feed_fetch_error` events among other measurements. `src/feed/analytics.ts` contains the read adapter, its four SQL queries, and typed projections.

The old Metrics and Timeline tabs are gone. The current consumer is the Overview panels route in `src/handlers/dashboard.ts`. The route requests all four projections through `queryAll([])` but publishes only `trend30d` in `analyticsEngine`. `src/client/components/overview-panels.tsx` renders that optional chart. Core Overview metrics come from D1 and remain independent of the Analytics Engine query.

| Projection | Query meaning | Current projection mapping |
| --- | --- | --- |
| `feedVelocity` | Last 30 days of `feed_new_articles`, grouped by `blob5`. Sum `double1`, average `double1` rounded to one decimal, and select the top 20 by total. | `feedId` from `feedId`, `title` from the D1-supplied title map or first eight Feed ID characters, and numeric values from `total_new_articles` and `avg_per_fetch`. |
| `fetchPerf` | Last 7 days of `feed_parse_duration_ms`, grouped by `blob5`. Count, rounded average, and rounded maximum of `double1`, sorted by average descending, with the top 20 selected. | Feed ID and resolved title; `samples`, `avgMs`, and `maxMs` from aliased result columns. |
| `errorRates` | Last 7 days of `feed_fetch_error`, grouped by `blob6`. Count events and distinct `blob5` Feed IDs, sorted by occurrence count descending. | `httpStatus`, `occurrences`, and `affectedFeeds`. |
| `trend30d` | Last 30 days of `feed_new_articles`, grouped by `toStartOfDay(timestamp)`. Sum `double1` and sort newest day first. | `day` is the first ten characters of the returned value; `newArticles` is numeric. This is the only projection currently shown in the dashboard. |

The source SQL uses the old Analytics Engine SQL dialect and endpoint. The query table is `rss_reader_metrics`. `index1` selects the event name, `blob5` holds Feed ID, `blob6` holds HTTP status, and `double1` holds count or duration. The typed mapper normalizes database values with `String()` and `Number()`. It supplies defaults for missing values and resolves titles from the supplied Feed activity list.

## Platform support and blockers

Cloudflare's [Analytics SQL Workers binding reference](https://developers.cloudflare.com/analytics/sql-api/workers-binding/) documents `analytics.binding` configuration, `env.<binding>.query({ query, params })`, named or positional parameters, account scope derived from the Worker, typed result rows, and returned execution statistics. It says the binding can query Workers Analytics Engine datasets as `events.analyticsEngine.<DATASET_NAME>`, subject to the account's Workers Analytics Engine entitlement. No `accountTag` predicate belongs in a binding query because the binding supplies account scope. It also says no request-level `time_range` is available, so each query must keep its lower timestamp bound in SQL.

The binding requires Wrangler 4.145.0 or later. The repository declares Wrangler `^4.152.0` in `package.json`, and the installed Wrangler 4.152.0 schema defines `analytics.binding`. Both satisfy the documented configuration requirement. This investigation did not configure a native binding, generate its types, run local binding tests, or execute a native query. Those checks remain prerequisites for migration. The binding configuration is absent from the committed `wrangler.jsonc` today.

The binding reference documents one `SELECT` statement per call, parameter values limited to string, number, boolean, or null, and no `FORMAT` clause. The unified [SQL API limits page](https://developers.cloudflare.com/analytics/sql-api/limits/) sets one statement and one dataset per query, a 10 KiB SQL statement limit, parser nesting depth 10, and a required lower timestamp bound. It documents variable dataset restrictions and query resource, rate, queue, and concurrency limits rather than a fixed universal ceiling. The [SQL errors page](https://developers.cloudflare.com/analytics/sql-api/errors/) documents `429`, `503`, and `507` resource/service failures and retry guidance. The Worker binding rejects with an error carrying a `retryable` boolean; it does not retry automatically. The current reader catches all HTTP errors and returns empty results, so any later adapter must preserve optional degradation without creating retries that can delay Overview requests.

The unified API documents SQL syntax shared across Cloudflare datasets, not just legacy Analytics Engine SQL. The [dataset guide](https://developers.cloudflare.com/analytics/sql-api/datasets/) names Analytics Engine datasets as `events.analyticsEngine.<DATASET_NAME>` and notes that these datasets are adaptively sampled. It says the unified API applies sample weights automatically to supported aggregates. This is a behavior difference from the legacy Analytics Engine SQL API, whose [sampling guidance](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) tells callers to account for `_sample_interval` in statistical aggregates. Confirm representative results before accepting any changed totals or counts.

The four existing query shapes appear translatable under the published SQL language reference: `SUM`, `AVG`, `COUNT`, `COUNT(DISTINCT ...)`, `MAX`, `ROUND`, `NOW() - INTERVAL`, `toStartOfDay`, grouping, ordering, and the existing `LIMIT` clauses are documented. The unified dataset reference explicitly retains aggregate `DISTINCT` compatibility for Analytics Engine datasets and permits `ORDER BY` without `LIMIT` for those datasets. This establishes documented syntax compatibility, not verified execution against this account's data. Check date bucket output formatting and result key casing because the old mapper receives a metadata-bearing legacy response while the binding returns `{ data, rows, statistics }` with row keys matching selected names or aliases.

Cloudflare's [announcement](https://blog.cloudflare.com/one-observability-platform/) calls the unified SQL API beta and announces a native Worker binding, but an announcement is not the configuration or API contract. Use the current [binding reference](https://developers.cloudflare.com/analytics/sql-api/workers-binding/) and [SQL API reference](https://developers.cloudflare.com/analytics/sql-api/) for implementation details. The binding documentation does not state a beta enrollment workflow, eligibility list, or plan matrix. The Analytics Engine entitlement requirement is explicit. Whether this account has that entitlement, whether beta access applies to this Worker, and whether its dataset can be queried are unknown without an authorized account-side check. No account was probed for this investigation.

## Supported implementation path

When the maintainer authorizes account verification, keep the change behind `AnalyticsReader` in `src/feed/analytics.ts` and preserve its typed domain projections. Configure the documented `analytics` binding with a distinct name such as `ANALYTICS_SQL`; do not replace the existing `ANALYTICS` write binding. Rewrite each table reference to `events.analyticsEngine."rss_reader_metrics"`, retain each timestamp lower bound and the `index1` event-name filter, and omit account-scope predicates because the binding supplies scope. Preserve the remaining event filters, window lengths, groupings, aliases, ordering, and limits. Adapt the mapper to the binding result's `{ data, rows, statistics }` contract.

The four query forms are each a single statement over one dataset and require no joins. The two top-20 queries already specify limits. Add bounded failure handling only if it preserves the current behavior: Analytics Engine query errors must not make D1-backed Overview fail. Do not expose the binding, raw rows, or Cloudflare query details to handlers or client code.

Keep the HTTP adapter available during the comparison period. Retain the existing `CF_API_TOKEN` secret and its Account Analytics Read permission. A safe rollback changes only the AnalyticsReader selection back to the current HTTP adapter using `https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`; it does not change metric writes, D1 state, authentication, or GReader responses. Remove the token requirement only after the maintainer validates production results and chooses to retire that rollback path. The Overview chart remains unavailable when Analytics Engine access fails; D1-backed panels continue to work.

## Maintainer verification before migration

1. Check the Cloudflare account's Analytics Engine entitlement and confirm that the Worker is eligible to use the native binding. This requires account access and was not attempted here.
2. Confirm that the deployed Worker configuration accepts the documented `analytics` binding and that the runtime exposes its `query()` method. The installed Wrangler version and schema support the configuration, but this investigation has not generated or verified native-binding environment types.
3. Run the four equivalent queries against the existing dataset with a controlled time window. Compare returned rows, type coercion, daily bucket string, sampled aggregation semantics, and empty/error handling with the existing HTTP adapter.
4. Compare the Overview trend shown by D1-backed panels plus the optional Analytics Engine chart. Confirm that Analytics Engine errors do not make the Overview API fail.
5. Keep `CF_API_TOKEN` configured while the native path is exercised. Test rollback by selecting the HTTP adapter and confirm that the Overview trend recovers without changing D1 or reader authentication.
6. Remove `CF_API_TOKEN` only after production validation succeeds and the maintainer approves removal of the HTTP rollback route.

Account eligibility and production query behavior remain unknown. Until those checks pass, the operational decision is to retain the HTTP adapter, current secret handling, Analytics Engine writes, and optional Overview behavior.

## Sources

- [Analytics SQL Workers binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/): binding configuration, API, scope, time bounds, response shape, and Analytics Engine eligibility.
- [Analytics SQL API](https://developers.cloudflare.com/analytics/sql-api/): unified API overview and endpoint model.
- [Analytics SQL datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/): Analytics Engine dataset names, adaptive sampling, and aggregate compatibility.
- [Analytics SQL language reference](https://developers.cloudflare.com/analytics/sql-api/sql-reference/): SQL language constraints and unsupported syntax.
- [Analytics SQL function reference](https://developers.cloudflare.com/analytics/sql-api/sql-reference/functions/): aggregates, `ROUND`, and date functions.
- [Analytics SQL limits](https://developers.cloudflare.com/analytics/sql-api/limits/): query-shape and service limits.
- [Analytics SQL errors](https://developers.cloudflare.com/analytics/sql-api/errors/): status codes and retry guidance.
- [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/): legacy endpoint, authentication, result format, and sampling.
- [Cloudflare observability announcement](https://blog.cloudflare.com/one-observability-platform/): product announcement only, not the binding contract.
- Repository references: `src/feed/analytics.ts`, `src/lib/metrics.ts`, `src/handlers/dashboard.ts`, `src/client/components/overview-panels.tsx`, `wrangler.jsonc`, `package.json`, and `docs/adr/0005-d1-and-analytics-engine.md`.
