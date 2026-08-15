# Troubleshooting RSS feed faults

This doc covers how to investigate feed-level failures using the observability
tooling already wired into my-greader.

## Error categories

All feed-fetch errors are classified into two types, which drive the deactivation
logic:

| Error type | Examples | Deactivation threshold | Behaviour |
|---|---|---|---|
| **Transient** | Network timeouts, DNS failures, HTTP 5xx, XML parse errors ("Unclosed root tag") | 5 consecutive | Adaptive polling backoff; retried every cycle until deactivated |
| **Permanent** | HTTP 401, 403, 404, 410 | 2 consecutive | Fast deactivation — these rarely self-resolve. The feed stays deactivated until manually reactivated from the Feed tab |

Rate limits (HTTP 429) do not count toward any deactivation threshold (they are
transient by nature but the server explicitly tells us to wait).

### Parse fallback

When `rss-parser` (xml2js) rejects a feed with an XML-level error (e.g. "Unclosed
root tag"), the parser falls back to a lenient HTML-based extractor that uses
[linkedom](https://github.com/WebReflection/linkedom). If the fallback succeeds,
the feed is marked `parseStatus=fallback` in structured logs and Analytics Engine
metrics. The fallback success is logged at `warn` level so it is visible in
Observability but does not raise an alert.

## Finding problem feeds

### 1. Dashboard — Feed tab

The **Feed tab** (`/app/feeds`) shows a "Feeds with issues" card at the top when
any feed is currently erroring or deactivated. Each feed row shows:

- A **status badge** (yellow = N errors, red = Deactivated)
- The **last error message** inline under the feed title
- The **poll interval** (backs off as errors accumulate)

From here you can **Reactivate** a deactivated feed or **Deactivate** one manually.

### 2. Dashboard — Metrics tab

Use the **Fetch errors by status** card (Analytics Engine, requires API token) to
see aggregate HTTP error rates over 7 days — broken down by status code and
number of affected feeds.

### 3. Structured logs (Workers Observability)

Workers Observability is enabled (`observability.enabled: true` in wrangler.jsonc).
Use the **Observability → Investigate → Query Builder** in the Cloudflare
dashboard:

```
-- Feeds that fell back to the lenient parser
parseStatus = "fallback"

-- Permanent HTTP errors (401/403/404/410)
httpStatus IN ("401", "403", "404", "410")

-- Hard parse failures (both parsers failed)
parseStatus = "failure"

-- Rate-limited feeds
httpStatus = "429"

-- Feeds serving text/html at their feed URL
contentType CONTAINS "text/html"
```

### 4. `wrangler tail`

Real-time structured log stream. Pipe through `jq` to filter:

```bash
wrangler tail | jq 'select(.logs[].message | contains("rss-parser failed"))'
wrangler tail | jq 'select(.httpStatus == 404)'
```

### 5. D1 queries

Query the `feeds` table directly to find feeds with errors:

```sql
SELECT title, feed_url, consecutive_errors, last_error, deactivated_at
FROM feeds
WHERE consecutive_errors > 0 OR deactivated_at IS NOT NULL
ORDER BY consecutive_errors DESC;
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

Check the structured log for the `parserError` field to see the exact xml2js
error message. If the fallback succeeded, the log will show "rss-parser failed,
parsed via lenient fallback" with the item count.

### Feed returning text/html Content-Type

Some servers misconfigure their feed endpoint to return `Content-Type: text/html`
instead of an XML type. A warning is logged when this is detected. The lenient
fallback parser (which is an HTML parser) handles these cases better than xml2js.

### Feed polling too slowly (long poll interval)

Poll intervals increase via adaptive backoff when a feed has no new items. Check
the **Poll interval distribution** card on the Metrics tab to see how many feeds
are at each backoff tier. Intervals reset to 30 minutes when new items appear.

If a feed is consistently at 4h+ intervals but has no errors, it is simply quiet.
The backoff is working as designed to avoid hammering low-volume feeds.

## Reset tools

- **Reactivate a feed**: Feed tab → click "Reactivate" next to the deactivated feed.
  This resets `consecutiveErrors`, `lastError`, `deactivatedAt`, and
  `checkIntervalMinutes` to defaults. The feed will be fetched on the next cycle.

- **Sync now**: Feed tab → click "Sync now" to trigger an immediate polling
  cycle for all due feeds without waiting for the 30-minute cron.
