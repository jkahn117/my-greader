# Operate My GReader

Deployment configures telemetry. It does **not** create alarms, notification destinations, a Custom Dashboard, or domain Trace Rules. Those need the optional setup below. There is no polling-stop watchdog: error alarms cannot detect a scheduler that never starts.

## Check the application

1. Open Overview and check the latest scheduled Cycle Run. Polling is scheduled every 30 minutes; a completed run with no Feeds due is valid. If activity is unexpectedly old or a run stays unfinished, inspect the `feed-polling` Workflow in Cloudflare. There is no automatic missing-run notification.
2. Open a failing Feed's detail and attempt history. Use [troubleshooting](troubleshooting.md) to distinguish an isolated upstream problem, normal Backoff, and broader failures.
3. After a deployment, confirm Access login and Current sync. Check that Overview and Feed detail still show durable history.

D1-backed application views establish durable outcomes. Logs and traces help investigation but can be lost or sampled.

## Verify deployed telemetry

1. In **Workers & Pages → my-greader → Observability**, confirm Workers Logs and Worker traces are enabled. Send a controlled reader request with a harmless, unique query marker. Find its invocation log and custom wide event; confirm the URL has no query string and the marker is absent from application logs. Use no real secret as the marker.
2. Inspect multiple requests for a sampled Worker trace with the same privacy properties. The configured baseline is 100% logs and 5% Worker traces, so one missing trace is expected. Neither configuration nor a live tail alone proves stored telemetry is redacted.
3. Review ingestion and storage using [the guidance below](#review-sampling-and-ingestion), especially after a traffic or sampling change.

## Configure optional Cloudflare monitoring

Start with one email monitor for [Workflow failures](#detect-workflow-failures-and-investigate-the-affected-cycle-run). First confirm the query schema, then create the monitor and test delivery. Add the other warnings only after observing enough normal traffic and polling volume to tune them. No monitor is implied by this document or by a successful deployment.

The remaining sections are setup reference, not routine reading. The recipes have not been executed against this account. Platform sources were checked on October 30, 2026; recheck their contracts before setup. Production deployment, account configuration, notification delivery, billing, and secret changes need separate approval.

### Verify access first

1. Confirm that the deployed release includes terminal Feed-attempt telemetry and the [request privacy and sampling configuration](../README.md#verify-request-observability).
2. Confirm that your Cloudflare account exposes the required observability features and that your role can read the Worker logs and manage the chosen alerts, dashboards, and domain tracing. Record any unavailable feature or permission instead of treating a documentation recipe as proof of account support.
3. Verify that `my-greader` is the deployed Worker name. Replace that name in queries if you configured another name.
4. Inspect a recent terminal log in Workers Observability. Confirm that the fields below are queryable before enabling an alert.

The [terminal-event adapter](../src/lib/polling-telemetry.ts) emits `eventName: "feed_attempt_completed"`, `cycleRunId`, `attemptId`, `feedId`, `outcome`, `errorClass`, `httpStatus`, `parserStatus`, and `newItems`. Outcomes are `new_items`, `unchanged`, `not_modified`, `rate_limited`, `failed`, and `skipped`. Parser statuses are `success`, `fallback`, `failure`, and `not_attempted`. Inapplicable HTTP status and error class are JSON nulls. Do not infer a parser failure from a missing HTTP status or count every error-level log as a distinct failed attempt.

Use `feedId` to find the durable evidence in application Feed detail. Shared polling events omit User identity, Feed URLs, and Feed titles. Logs are best effort and can be lost after a D1 commit. No alert or chart replaces D1-backed Overview, Feed detail, or Reading. Inbound domain analytics describe requests to this service, not outbound Feed polling.

## Discover the log schema before copying SQL

[Alert monitors](https://developers.cloudflare.com/notifications/monitors/) evaluate the unified SQL API. Its [supported SQL dialect](https://developers.cloudflare.com/analytics/sql-api/sql-reference/) is not arbitrary ClickHouse or legacy Log Explorer SQL. A custom monitor query must return one numeric column named `value`, select one schema-qualified dataset, include account or zone scope, and omit a trailing semicolon.

1. In **Alerts → Monitors → Create a Monitor**, check that Workers Logs is available for the selected account. The [SQL dataset reference](https://developers.cloudflare.com/analytics/sql-api/datasets/) names it `logs.workersLogs`, not `logs.workers`. Availability in documentation does not establish access in this account.
2. Use the query builder and Logs field browser to inspect a recent invocation, Hono wide event, terminal attempt, and Workflow failure if one exists. Confirm the exact columns or JSON attribute keys and their types. Do not cause a Workflow failure to obtain a sample.
3. If approved read-only API access is needed for discovery, use a restricted operator token with Account Analytics Read permission. This is not an instruction to change the application's `CF_API_TOKEN`. Set the two environment variables in your secure operator environment, then run:

```bash
curl --fail-with-body --get \
	"https://api.cloudflare.com/client/v4/analytics/sql/introspection" \
	--header "Authorization: Bearer ${CF_OBSERVABILITY_READ_TOKEN:?Set a restricted operator token}" \
	--data-urlencode "account_tag=${CF_ACCOUNT_TAG:?Set the account tag}" \
	--data-urlencode "dataset_name=logs.workersLogs" \
	--data-urlencode "include_columns=true" \
	--data-urlencode "include_attributes=true"
```

4. Record the dataset's sampling kind and the SQL expression for each application field used below. `include_attributes` discovers keys from only the preceding seven days and can silently truncate its results. An absent key is not proof that it can never appear. A catalog entry is not proof of query permission either.

The SQL templates below assume the logger's JSON fields are exposed as exact keys in `attributes`, including `message`. That mapping has **not** been verified for this account. Use these templates only after discovery confirms it. If a field is instead a named column, replace its whole `attributes['key']` expression with that column. If the mapping is unavailable, leave the affected monitor unconfigured and use the Logs field browser for investigation. Do not guess a nested JSON path.

[SQL JSON lookups](https://developers.cloudflare.com/analytics/sql-api/sql-reference/data-types/#json-fields) use exact top-level keys. A dotted key is not nested traversal. The SQL API restricts JSON operations and aggregate `DISTINCT` on sampled datasets, so these recipes count rows with `COUNT(*)`, not distinct Feeds or attempts. They do not establish exact durable counts.

The Hono wide event adds numeric `status` and `duration_ms` after a handled HTTP request. These are distinct from terminal polling `httpStatus` and `parserStatus`. The request recipes require both wide-event fields so they do not count unrelated error logs or outbound Feed responses. Verify that the selected account dataset supports numeric JSON comparison and `AVG` before enabling them. If not, use the builder's equivalent typed fields or leave that monitor blocked.

## Create threshold monitors

Use **Threshold** detection and **Manual** time-range mode for the complete queries below. Replace `<ACCOUNT_TAG>` and any field expressions identified during discovery. Keep the SQL window and UI evaluation window aligned. Do not combine these explicit bounds with Automatic mode. For Automatic mode instead, remove the timestamp predicate and understand that the window spans the execution interval.

Start with a ten-minute execution interval where supported and a one-hour repeat notification interval. Log Explorer datasets have a ten-minute minimum execution interval. Other datasets may allow faster checks, but verify the selected dataset's limit. These are initial operating choices, not measured incident baselines.

### Detect Workflow failures and investigate the affected Cycle Run

```sql
SELECT COUNT(*) AS value
FROM logs.workersLogs
WHERE accountTag = '<ACCOUNT_TAG>'
  AND timestamp >= NOW() - INTERVAL '10' MINUTE
  AND scriptName = 'my-greader'
  AND attributes['message'] = 'feed polling workflow failed'
```

Set `value >= 1` over ten minutes and route it as an urgent infrastructure investigation. This message comes from the [Workflow's outer catch](../src/workflows/feed_polling.ts), after an error escapes its steps. Earlier `get-due-feeds step failed`, `fetch-batch-N step failed`, and `record-cycle step failed` logs can be retried and are not equivalent to a final Workflow failure.

Use the log's `cycleRunId` to correlate the Cycle Run and its Feed attempts with D1-backed application evidence. This is also the available log signal for a Cycle Run infrastructure error, not a separate guaranteed durable error event. The optional Analytics Engine `cycle_error` metric is not a Workers Logs event name. Do not configure a duplicate monitor by inventing `cycle_run_error`, and do not infer overall Workflow failure from a failed individual Feed.

### Detect failed Feed-attempt volume

```sql
SELECT COUNT(*) AS value
FROM logs.workersLogs
WHERE accountTag = '<ACCOUNT_TAG>'
  AND timestamp >= NOW() - INTERVAL '1' HOUR
  AND scriptName = 'my-greader'
  AND attributes['eventName'] = 'feed_attempt_completed'
  AND attributes['outcome'] = 'failed'
```

Start with `value >= 5` over one hour as a warning, not a page. An hour spans two scheduled polling opportunities, though Backoff, Deactivation, manual runs, and retries affect volume. Check the affected Feed IDs and total terminal volume before escalation. Failures across several unrelated Feeds suggest a wider incident. Repeated failure of one upstream Feed belongs in Feed detail and does not by itself establish a service outage.

### Detect parser failures

```sql
SELECT COUNT(*) AS value
FROM logs.workersLogs
WHERE accountTag = '<ACCOUNT_TAG>'
  AND timestamp >= NOW() - INTERVAL '1' HOUR
  AND scriptName = 'my-greader'
  AND attributes['eventName'] = 'feed_attempt_completed'
  AND attributes['outcome'] = 'failed'
  AND attributes['parserStatus'] = 'failure'
  AND attributes['errorClass'] = 'parse'
```

Start with `value >= 3` over one hour as a warning. Group the matching events by Feed before deciding whether a parser regression is broad. `parserStatus = 'fallback'` is a successful lenient parse, not a parser failure. Inspect its trend separately rather than paging on it.

### Detect elevated rate limiting

```sql
SELECT COUNT(*) AS value
FROM logs.workersLogs
WHERE accountTag = '<ACCOUNT_TAG>'
  AND timestamp >= NOW() - INTERVAL '1' HOUR
  AND scriptName = 'my-greader'
  AND attributes['eventName'] = 'feed_attempt_completed'
  AND attributes['outcome'] = 'rate_limited'
  AND attributes['httpStatus'] = 429
```

Start with `value >= 5` over one hour as an informational warning. A single upstream 429 is expected Backoff behavior, not a failed attempt or Worker outage. Check Feed diagnostics and `Retry-After` behavior before increasing traffic or forcing another poll. Keep this monitor separate from failed-attempt volume.

### Detect HTTP service errors

```sql
SELECT COUNT(*) AS value
FROM logs.workersLogs
WHERE accountTag = '<ACCOUNT_TAG>'
  AND timestamp >= NOW() - INTERVAL '10' MINUTE
  AND scriptName = 'my-greader'
  AND attributes['duration_ms'] >= 0
  AND attributes['status'] >= 500
```

Start with `value >= 3` over ten minutes as a warning. This counts handled HTTP 5xx wide events, not all Worker invocation failures. It excludes expected reader authentication failures and does not count a Feed server's 500 response as this service's HTTP 500.

For platform invocation errors that prevent a wide event, create an additional builder-based monitor only if its dataset exposes invocation **Outcome** and **Event type**. Restrict to invocation events for `my-greader`, select the actual error outcomes shown by the field browser, and count **Events**. Start at `value >= 1` over ten minutes for an urgent investigation. Let the builder generate the actual SQL field names instead of translating UI labels into guessed columns. Use the invocation-error panel below if this monitor dataset is unavailable.

### Detect slow handled requests

```sql
SELECT AVG(attributes['duration_ms']) AS value
FROM logs.workersLogs
WHERE accountTag = '<ACCOUNT_TAG>'
  AND timestamp >= NOW() - INTERVAL '10' MINUTE
  AND scriptName = 'my-greader'
  AND attributes['duration_ms'] >= 0
  AND attributes['status'] >= 100
```

Start with `value > 1000` milliseconds over ten minutes as a latency warning. Compare it with the request count and route breakdown before escalation. At low traffic, one slow request can dominate the mean. Tune after a representative week, and use the dashboard's available percentiles to investigate tails rather than treating the mean as an SLO. This is Hono request handling time, not full browser latency, platform CPU time, Workflow wall time, or outbound Feed fetch duration.

### Route notifications and tune the thresholds

Use email for the initial warnings. [Monitor destinations](https://developers.cloudflare.com/notifications/monitors/#monitor-details) support up to 20 email recipients and webhooks on all plans. PagerDuty requires a Business or higher zone. Verify destination access, ownership, and delivery in the actual account before relying on an urgent route. Avoid forwarding raw diagnostic text or sensitive request fields to shared destinations.

After a representative week, record normal request counts, scheduled and manual polling volume, failed Feed distribution, parser failures, and 429 volume. Adjust thresholds to that evidence. A threshold on total events does not automatically enforce a minimum number of affected Feeds. Keep isolated upstream problems at warning severity, and escalate correlated multi-Feed failures or platform invocation failures. Check repeat frequency separately from execution frequency. Do not assume a recovery notification is sent unless verified.

Do not create a missing-Cycle-Run alert from these logs. The monitor contract says that no returned rows means no signal, and a zero count does not prove that ingestion or scheduled execution is healthy. The empty-selection Workflow path also returns without the normal `feed polling cycle complete` log. Reliable absence detection is not established here. Inspect the latest durable Cycle Run in Overview instead. An independently verified heartbeat would be separate work.

## Build an operations Custom Dashboard

1. Open the account's **Analytics → Custom dashboards** and create a blank dashboard named `My GReader operations`. [Custom Dashboards](https://developers.cloudflare.com/analytics/custom-dashboards/) are available to all customers, with up to 100 per account. They belong to the account and are viewable by account members with access, not just their creator.
2. Set a default 24-hour time range within the retained log window. Apply `my-greader` script filtering to each Worker panel. Do not apply a dashboard-wide hostname filter to polling panels: Workflow and cron events need not carry an inbound hostname.
3. Add the panels below through manual dataset, metric, dimension, and filter configuration. For custom terminal fields, build the visualization in [Logs](https://developers.cloudflare.com/observability/logs/) using its field browser, then add it to the Custom Dashboard. Dashboard UI labels are not SQL identifiers, and arbitrary SQL pasted into a chart is not a documented requirement.

| Panel | Dataset and metric | Filters and grouping |
| --- | --- | --- |
| Worker traffic and invocation failures | Workers Observability Logs, **Events**, timeseries at a ten-minute interval | Script name `my-greader`; restrict **Event type** to invocation logs, identified in Workers Logs by `$cloudflare.$metadata.type = "cf-worker-event"`. Group by the platform **Outcome**. Select observed error outcomes for a separate error stat. Do not mix console logs into the invocation denominator. |
| HTTP errors and request count | Logs, event count, timeseries | Require the confirmed wide-event fields `duration_ms >= 0` and `status >= 100`. Add a second series with `status >= 500`. Group by status. Use the same base population for any error percentage. |
| Request handling latency | Logs, average `duration_ms`, timeseries | Use the same wide-event filters. Add route or message grouping only if the field browser exposes a useful non-sensitive value. Label the metric in milliseconds. |
| Platform invocation duration | Workers Observability Logs, **Duration** or **Wall time**, timeseries | Script name and invocation event type; restrict **Trigger** to HTTP fetch invocations. Use available percentiles and group by status or outcome. Label the chosen metric and unit exactly as shown. Do not combine Workflow step duration with HTTP latency. |
| Workflow and Cycle Run infrastructure errors | Logs, event count, timeseries and a recent-event table | Message equals `feed polling workflow failed`; show `cycleRunId` and time. Inspect step-error messages separately for retry context. There is no separate guaranteed Cycle Run error event. |
| Terminal Feed-attempt outcomes | Logs, event count, stacked timeseries at a 30-minute interval | `eventName = "feed_attempt_completed"`; group by terminal `outcome`, not the platform invocation outcome. |
| Failed and parser-failed Feeds | Logs, event count, Top List | Terminal event filter plus `outcome = "failed"`; group by `feedId` and `errorClass`. Add a parser series with `parserStatus = "failure"`. Inspect `fallback` separately. |
| Rate-limited Feeds | Logs, event count, Top List | Terminal event filter plus `outcome = "rate_limited"` and `httpStatus = 429`; group by `feedId`. |

Select the actual custom field names and typed filter values discovered earlier. If custom grouping is unavailable in the account's chart source, retain a filtered Logs table and record the missing panel capability. Do not substitute a generic error-level count for terminal failures. The terminal event has no duration field, so these recipes do not invent a per-Feed fetch-latency chart.

Change the time range to a recent polling window and confirm the panels populate where matching retained events exist. Check Feed IDs against application Feed detail and compare the latest Cycle Run with Overview. Empty charts outside retention are not evidence of no historical errors. Keep inbound domain traffic panels separate and label them as inbound only.

## Verify alerts without causing a production failure

1. Preview each query over a recent retained period, up to the supported seven-day preview limit. Validate its field mapping, scalar `value`, scope, time window, and threshold before saving. Preview is approximate and can differ from monitor evaluation. Record unavailable datasets or fields as setup blockers.
2. Get approval to create the monitor and its destinations. Use [the alert's **Test** action](https://developers.cloudflare.com/notifications/get-started/) to send sample data and verify notification routing. Check alert history and the destination. This proves delivery, not matching of application events.
3. For a real evaluation test without a fault, create a temporary monitor for successful handled requests. Copy the HTTP error query, replace `attributes['status'] >= 500` with `attributes['status'] >= 200 AND attributes['status'] < 300`, and set `value >= 1`. Send one read-only authenticated Overview request during the evaluation window, then wait for an evaluation and verify the delivery. Remove the temporary monitor afterward. This confirms the live wide-event mapping and evaluation route, not Workflow or parser failure detection.
4. For failure-specific filters, compare previews with naturally occurring retained events when available. If no matching event exists, record that end-to-end trigger verification is pending. Do not throw production errors, damage a Feed, revoke credentials, force repeated polling, or loosen Access to test an alert. Any staging failure exercise requires separate approval.
5. Record monitor names, query and field mappings, thresholds, evaluation and repeat intervals, destinations, preview evidence, delivery test, temporary-test cleanup, dashboard panels, and remaining blockers. Recheck D1-backed Overview and Feed detail, Access login, and Current sync after any separately approved deployment.

Account setup, alert evaluation, notification delivery, dashboard population, and production sampling remain unverified until the maintainer records those observations. No setup or verification is implied by completing this document.

## Investigate one request with a temporary Trace Rule

[Cloudflare Traces configuration](https://developers.cloudflare.com/observability/traces/configuration/) is domain-specific. These rules do not override the separate Worker trace sampling rate.

1. Get approval for the temporary domain tracing change and a short investigation window, such as 15 minutes. Verify telemetry access controls and retention first. [Domain traces capture URLs and query strings](https://developers.cloudflare.com/observability/traces/), unlike the Worker's explicit query-redaction policy. Do not send secrets or sensitive markers in a query string.
2. Open **Cloudflare Traces → Configuration → Trace rules** for the relevant domain. Replace `reader.example.com` below with the deployed hostname.
3. Create a rule with this custom filter and a 100% sample rate. Put it before broader matching rules because the first matching rule wins.

```text
http.host eq "reader.example.com"
and http.request.uri.path eq "/app/api/overview"
and any(http.request.headers["x-my-greader-debug"][*] eq "ops-check")
```

4. Save the rule as a draft to inspect its filter. Deploy it only for the approved investigation.
5. While signed into the management dashboard, use the browser console on that same origin to send one read-only request. This uses the existing Access session without copying an API Token or session cookie into a command.

```js
const response = await fetch("/app/api/overview", {
	headers: { "x-my-greader-debug": "ops-check" },
});
console.info({ status: response.status, rayId: response.headers.get("cf-ray") });
```

6. Confirm the expected successful response. In Traces, select the matching time window and search the Ray ID with `cloudflare.ray_id = "<ray>"`. A Ray ID search cannot retroactively capture an unsampled request. The debug header is an investigation selector, not authentication or permission to bypass Access.
7. Inspect the request path and available spans. A gap can still occur when Worker tracing is disabled or not captured at its own configured rate. Do not promise full Worker spans merely because the domain rule samples at 100%.
8. Disable or remove the temporary rule when the window ends. Record the rule, time window, Ray ID, findings, and restoration of the original settings. Confirm that subsequent requests without the header do not match this rule.

For a path-wide investigation, omit only the header clause, keep the hostname and path restrictions, and choose the smallest useful temporary rate and window. This captures more traffic and requires the same privacy review. Do not use eventual response status or duration in a Trace Rule: sampling happens before either is known. Use error and latency log queries to choose which path to investigate next.

The [Rules field references](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.headers/) define lowercase header keys and array matching. Do not forward W3C trace context to arbitrary third-party Feed servers. A domain rule for incoming traffic is not an outbound polling instrumentation change.

## Review sampling and ingestion

Keep the repository baseline of logs at `1` and Worker traces at `0.05`. [Worker log sampling](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#head-based-sampling) includes all logs in a sampled invocation. [Worker trace sampling](https://developers.cloudflare.com/workers/observability/traces/#sampling) is separate and head-based. Five-percent traces are investigation samples, not exact failure counters or an availability denominator.

Even at 100% configured log sampling, delivery failure, truncation, retention, and account ingestion limits can remove evidence. If you reduce logging, revalidate count-based thresholds and check the query product's own sampling behavior. Events within one invocation are correlated, so multiplying a partial count by the inverse sampling rate does not recover reliable small-volume alerting.

The [current pricing reference](https://developers.cloudflare.com/observability/pricing/) confirms that the shared logs-and-traces pricing begins **December 1, 2026**:

- Free includes 0.5 GB ingestion per day and seven-day retention. Ingestion stops at the daily allowance and resumes at 00:00 UTC. Stored data remains queryable until retention expires.
- Paid includes 50 GB ingestion and 10 GB-month storage per billing cycle. Overage is $0.25 per GB ingested and $0.10 per GB-month stored. Usage continues automatically beyond the allowances. Enterprise accounts move at contract renewal.
- Ingestion and storage are separate, shared account-level meters. Queries, dashboards, and alerts have no additional charge under this model. Log Explorer datasets have separate pricing and do not consume those pooled allowances.

Before December 1, follow the existing pricing shown in the product-specific documentation. The new pricing is not a promise that current usage is free, and this repository has not inspected the account's plan or usage.

After deployment, after any temporary sampling increase, and after traffic changes, review the account's available usage view. When available, **Billable Usage** shows ingestion, storage, remaining allowances, and estimated charges. Record observed volume, the plan and billing period, retention, active investigation rules, and expected headroom. Review again after the December 1 transition. Restore expired investigation settings before considering a baseline reduction.
