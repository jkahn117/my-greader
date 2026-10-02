# Troubleshooting RSS feed faults

This doc covers how to investigate feed-level failures using the observability
tooling already wired into my-greader.

## Error categories

All feed-fetch errors are classified into two types, which drive the deactivation
logic:

| Error type | Examples | Deactivation threshold | Behaviour |
|---|---|---|---|
| **Transient** | Network timeouts, DNS failures, HTTP 5xx, XML parse errors ("Unclosed root tag") | 5 consecutive | Retried at the Feed's current interval until deactivated |
| **Permanent** | HTTP 401, 403, 404, 410 | 2 consecutive | Fast deactivation — these rarely self-resolve. The feed stays deactivated until manually reactivated from the Feed tab |

Rate limits (HTTP 429) do not count toward any deactivation threshold (they are
transient by nature but the server explicitly tells us to wait).

### Parse fallback

When `rss-parser` (xml2js) rejects a Feed with an XML-level error (e.g. "Unclosed
root tag"), the parser falls back to a lenient HTML-based extractor that uses
[linkedom](https://github.com/WebReflection/linkedom). A successful fallback is
stored as `parser_status = 'fallback'` on the durable Feed attempt, shown on the
Timeline, and emitted as an Analytics Engine parse-status dimension.

## Finding problem feeds

### 1. Dashboard — Feed tab

The **Feed tab** (`/app/feeds`) shows a "Feeds with issues" card at the top when
any feed is currently erroring or deactivated. Each feed row shows:

- A **status badge** (yellow = N errors, red = Deactivated)
- The **last error message** inline under the feed title
- The last successful check and last precise new-Item discovery
- Whether initial backload completed
- The **poll interval** and next eligibility time
- The recorded Deactivation reason

From here you can **Reactivate** a deactivated feed or **Deactivate** one manually.

### 2. Dashboard — Timeline tab

The **Timeline tab** (`/app/timeline`) is the durable source for recent polling
outcomes. Expand a Cycle Run to see each subscribed Feed attempt, its outcome,
HTTP or parse diagnostic, fallback-parser badge, stable attempt ID, and newly
attributed Items. Use the attempt ID to correlate the row with structured logs.

### 3. Dashboard — Metrics tab

Use the **Fetch errors by status** card (Analytics Engine, requires API token) to
see aggregate HTTP error rates over 7 days, broken down by status code and
number of affected Feeds. Network and parse failures are not HTTP-status metrics;
use the Timeline or D1 for those.

### 4. Structured logs (Workers Observability)

Workers Observability is enabled (`observability.enabled: true` in
`wrangler.jsonc`). The Workflow emits one `feed polling attempt completed` log
per terminal attempt. In **Observability → Investigate → Query Builder**, filter
on fields that are present on those logs:

```
-- Failed Feed attempts
outcome = "failed"

-- Network, HTTP, or parse failures
errorClass = "network"
errorClass = "http"
errorClass = "parse"

-- Rate-limited or skipped attempts
outcome = "rate_limited"
outcome = "skipped"

-- One durable attempt or Feed
attemptId = "<cycle-run-id>:<feed-id>"
feedId = "<feed-id>"
```

HTTP status and parser status are durable D1 fields shown by the Timeline; they
are not attached to every terminal structured log.

### 5. `wrangler tail`

Stream the same terminal logs in real time and filter their structured fields:

```bash
pnpm wrangler tail --format json | jq 'select(any(.logs[]?; .message | contains("feed polling attempt completed")))'
pnpm wrangler tail --format json | rg 'errorClass.*parse'
```

### 6. D1 queries

Query current Feed health:

```sql
SELECT title, feed_url, last_successful_poll_at,
       last_new_item_discovered_at, initial_backload_completed_at,
       next_poll_at, consecutive_errors, last_error,
       deactivated_at, deactivation_reason
FROM feeds
WHERE consecutive_errors > 0 OR deactivated_at IS NOT NULL
ORDER BY consecutive_errors DESC;
```

Query recent durable attempt detail, including fields not present on every log:

```sql
SELECT id, cycle_run_id, feed_id, outcome, error_class,
       http_status, parser_status, diagnostic, started_at, completed_at
FROM feed_poll_attempts
WHERE outcome IN ('failed', 'rate_limited')
   OR parser_status IN ('fallback', 'failure')
ORDER BY started_at DESC
LIMIT 100;
```

## Common scenarios

### Feed deactivated after HTTP 404

The feed URL returned a 404 — the feed has been moved or deleted. Two options:

1. Find the new feed URL on the publisher's site and re-add it via OPML import
   (the old feed will stay deactivated).
2. If the 404 was a transient server error: reactivate from the Feed tab.

### Feed deactivated after HTTP 403

The server is forbidding access. Likely causes:

- The feed requires authentication (e.g. Patreon, Substack private feed). These
  are not currently supported — add the public RSS URL instead.
- Cloudflare or a WAF is blocking the `my-greader/1.0` user agent. Try a
  different feed URL.
- IP-based geo-blocking (Cloudflare Workers egress from Cloudflare's IP ranges).

### "Unclosed root tag" parse errors

The feed's XML is truncated or malformed. The lenient fallback parser will
attempt to recover items. If the fallback also fails, the feed will accumulate
errors and eventually deactivate.

Check the Timeline or `feed_poll_attempts.diagnostic` for the bounded parser
message. A successful fallback has `parser_status = 'fallback'`; a hard failure
has `parser_status = 'failure'` and `error_class = 'parse'`.

### Feed polling too slowly (long poll interval)

Poll intervals increase via adaptive backoff when a feed has no new items. Check
the **Poll interval distribution** card on the Metrics tab to see how many feeds
are at each backoff tier. Intervals reset to 30 minutes when new items appear.

If a Feed is consistently at the four-hour interval with no errors, it is
simply quiet. An interval above four hours comes from a longer Feed `<ttl>` (up
to 24 hours) or a server `Retry-After` value after HTTP 429.

## Reset tools

- **Reactivate a feed**: Feed tab → click "Reactivate" next to the deactivated feed.
  This resets `consecutiveErrors`, `lastError`, `deactivatedAt`,
  `deactivationReason`, `checkIntervalMinutes`, and `nextPollAt`. The Feed will
  be eligible on the next cycle.

- **Sync now**: Feed tab → click "Sync now" to trigger an immediate polling
  cycle for all due feeds without waiting for the 30-minute cron.
