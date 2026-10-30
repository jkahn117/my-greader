# Investigate a Feed problem

Start with the application dashboard. Its history comes from D1 and remains available when optional Analytics Engine queries fail. For deployment checks or Cloudflare log and alarm setup, use [operations](operations.md).

## Check whether the problem is one Feed or polling itself

1. Open Overview and inspect the latest Cycle Run. A completed run with no Feeds due is normal; an old or unfinished run needs investigation in the `feed-polling` Workflow. There is no automatic polling-stop watchdog.
2. Open **Feeds** and filter for failing, rate-limited, or deactivated Feeds. Open a Feed to compare its last successful check, last new Item, next eligibility, and Backoff interval.
3. Expand a recent attempt in Feed detail. Read its outcome, HTTP status, parser status, and bounded diagnostic. Copy its full attempt ID when correlating it with logs.

A successful check without new Items is not a failure. Next eligibility is not a promised execution time. Several unrelated Feeds failing together warrant a wider investigation; one failing publisher does not establish an application outage.

## Interpret the evidence

| Evidence | Meaning and next step |
| --- | --- |
| `new_items`, `unchanged`, or `not_modified` | Successful check. A 304 or unchanged Feed can legitimately add no Items. |
| `rate_limited`, HTTP 429 | The upstream server asked us to wait. Backoff applies, and the attempt does not increment the Deactivation error counter. Do not force repeated checks. |
| `failed`, `errorClass: network` | A network request failed. Use the diagnostic to investigate; do not infer a publisher or platform outage from one attempt. |
| `failed`, `errorClass: http` | Inspect the HTTP status. A 403 proves a forbidden response, not which provider blocked it. A 404 does not by itself prove the Feed moved. |
| `parserStatus: fallback` | Strict parsing failed, but lenient extraction succeeded. This is not a hard parser failure. |
| `failed`, `parserStatus: failure`, `errorClass: parse` | Both parsing paths failed. The response may be malformed XML or something else, such as an HTML error page. |
| `skipped` or unfinished work | Not a successful HTTP check or a failed Feed. Inspect ownership and lifecycle evidence before treating it as either. |

The parser uses Feedsmith after strict XML validation, with a lenient linkedom fallback in the polling path. See [the parser](../src/lib/feed-parser.ts) and [polling policy](../src/feed/poll.ts) when debugging implementation behavior.

## Understand Deactivation and Backoff

The current polling policy deactivates after five consecutive transient errors, including network, parser, and HTTP 5xx failures. HTTP 401, 403, 404, and 410 are permanent errors and deactivate after two consecutive errors. HTTP 429 is handled separately and does not count toward those thresholds.

Quiet Feeds back off to four hours. A longer Feed-provided `<ttl>` can extend eligibility up to 24 hours, and HTTP 429 can carry a `Retry-After` hint. A long interval without errors can therefore be normal. New Items reset the normal interval to 30 minutes unless a longer Feed timing hint applies.

Use Feed detail's **Reactivate** or **Deactivate** controls only after understanding the evidence. They change the shared Feed for every subscriber. Reactivation clears error health and Deactivation and makes the Feed eligible again; it does not repair a broken upstream URL.

**Sync now** starts normal global polling without waiting for cron. **Force sync** bypasses due time only, not Deactivation or the requirement for a Subscription. Neither action is a remedy for an upstream rate limit.

## Correlate with logs only when needed

Terminal logs use `eventName: "feed_attempt_completed"` and include `cycleRunId`, `attemptId`, `feedId`, `outcome`, `errorClass`, `httpStatus`, `parserStatus`, and `newItems`. Inapplicable HTTP status and error class are explicit JSON nulls. Failed attempts include a bounded, credential-redacted diagnostic.

Filter by the stable event name and copied attempt ID using the actual fields exposed in the account's Logs browser. The [operations schema-discovery steps](operations.md#discover-the-log-schema-before-copying-sql) explain why SQL field paths must be checked rather than guessed. Shared polling logs omit User identity, Feed URLs, and Feed titles.

Logging is best effort: a D1 commit can succeed without a corresponding log. Feed attempt history is retained for 90 days; expired or legacy history is unknown rather than success. Items are attributed to their first ingestion attempt, never inferred from timestamps, and Item retention can remove content from an otherwise retained attempt. See [architecture](architecture.md#request-and-polling-flow) for persistence and retention details.

For connection or authentication failures rather than Feed polling, check [README's reader setup](../README.md#4-connect-an-rss-reader). Developers investigating those paths can use the [authentication](auth-flow.md) and [GReader API](reference/greader-api.md) references.
