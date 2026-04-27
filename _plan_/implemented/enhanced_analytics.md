# Enhanced Analytics

## What's implemented

**D1-backed dashboard (no Pipeline needed):**
- `last_new_item_at` on the feeds table — updated whenever new articles are stored. Surfaces in the Feeds tab as "Last new item" relative-time. Answers "is this feed quiet or broken?" at a glance.
- `cycle_runs` table — one row per Workflow execution. Written in the `record-cycle` step. Backs the polling cycles timeline (last 20 runs, bar chart + table), aggregate KPIs (avg due/cycle, avg failed/cycle), and the "Last cycle" stat card.
- `item_state.read_at` — stamped when `isRead = 1` is set via the GReader state endpoint. Backs the reads-by-day card (7-day window, grouped by `DISPLAY_TIMEZONE`).
- Poll interval distribution card — shows how backed-off the fleet is across tiers (30m / 1h / 2h / 4h).
- Feed health card — erroring / rate-limited / deactivated feeds surfaced from D1.

**Pipeline (`rss_reader_metrics`) → R2 Data Catalog (Iceberg) — queryable via R2 SQL:**

The sink is `--type r2-data-catalog`, writing to `rss_reader.metrics` in the `rss-reader-metrics-store` bucket. Named-field records are written via `@workers-powertools/metrics` PipelinesBackend. Schema defined in `pipeline-schema.json`.

| Metric name              | When emitted                        | Key dimensions            |
| ------------------------ | ----------------------------------- | ------------------------- |
| `feed_parse_duration_ms` | After each feed fetch               | `feedId`, `status`        |
| `feed_new_articles`      | When new articles are stored        | `feedId`                  |
| `feed_parse_failure`     | On parse error                      | `feedId`, `error`         |
| `feed_fetch_error`       | On 429 / non-OK HTTP response       | `feedId`, `httpStatus`    |
| `cycle_new_articles`     | End of each Workflow run            | —                         |
| `cycle_failed_feeds`     | End of each Workflow run            | —                         |
| `cycle_checked_feeds`    | End of each Workflow run            | —                         |
| `cycle_error`            | Workflow-level failure              | `error`                   |
| `article_read`           | GReader `edit-tag` marks read       | `userId`                  |
| `subscription_change`    | Subscribe / unsubscribe / edit      | `userId`, `action`        |

---

## R2 SQL query client

Queries are HTTP POSTs to the R2 SQL REST API — same pattern as the old `wae.ts` WAE client.

```typescript
// src/lib/r2sql.ts
export interface R2SqlResult {
  data: Record<string, string | number | null>[];
  meta: { name: string; type: string }[];
}

export async function queryR2Sql(
  accountId: string,
  bucketName: string,
  authToken: string,
  sql: string,
): Promise<R2SqlResult> {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/r2-sql/query/${bucketName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    // No data yet (table doesn't exist) — treat as empty
    if (res.status === 404) return { data: [], meta: [] };
    throw new Error(`R2 SQL query failed (${res.status}): ${text}`);
  }
  return res.json<R2SqlResult>();
}
```

Required env additions:
- `R2_SQL_AUTH_TOKEN` secret — R2 SQL Read + Data Catalog + R2 Storage permissions
- `CF_ACCOUNT_ID` var — already present in `wrangler.jsonc`
- R2 bucket name can be hardcoded or added as a var (`rss-reader-metrics-store`)

---

## Proposed dashboard views

These can be added as a new section on the existing metrics tab (or a separate `/app/analytics` tab). All queries reference `rss_reader.metrics`.

### 1 — Feed velocity (top publishers)

**Question**: which feeds are publishing most actively, and which have gone quiet?

```sql
SELECT
  feedId,
  COUNT(*)                            AS fetch_count,
  SUM(metric_value)                   AS total_new_articles,
  ROUND(AVG(metric_value), 1)         AS avg_per_fetch
FROM rss_reader.metrics
WHERE metric_name = 'feed_new_articles'
  AND timestamp > DATEADD('day', -30, NOW())
GROUP BY feedId
ORDER BY total_new_articles DESC
LIMIT 20
```

UI: table sorted by `total_new_articles`, cross-referenced with the feed title from D1. Shows feeds by output volume over the last 30 days — useful for spotting silent feeds and high-volume sources.

---

### 2 — Fetch performance (slowest feeds)

**Question**: which feeds are slow to parse, and are any consistently timing out?

```sql
SELECT
  feedId,
  COUNT(*)                            AS samples,
  ROUND(AVG(metric_value))            AS avg_ms,
  ROUND(MAX(metric_value))            AS max_ms,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY metric_value)) AS p95_ms
FROM rss_reader.metrics
WHERE metric_name = 'feed_parse_duration_ms'
  AND timestamp > DATEADD('day', -7, NOW())
GROUP BY feedId
ORDER BY avg_ms DESC
LIMIT 20
```

UI: table of slowest feeds with avg/p95 duration. Feeds consistently above ~5s are candidates for investigation (slow servers, large payloads, no ETag support).

---

### 3 — Error rates by HTTP status

**Question**: what is the breakdown of fetch errors, and which status codes are most common?

```sql
SELECT
  httpStatus,
  COUNT(*) AS occurrences,
  COUNT(DISTINCT feedId) AS affected_feeds
FROM rss_reader.metrics
WHERE metric_name = 'feed_fetch_error'
  AND timestamp > DATEADD('day', -7, NOW())
GROUP BY httpStatus
ORDER BY occurrences DESC
```

UI: small table of HTTP status → occurrence count → affected feed count. 429s indicate rate-limited feeds; 403s indicate access-denied sources worth removing; 5xx are transient server issues.

---

### 4 — New articles per day (pipeline vs D1)

**Question**: how has daily article volume trended over the last 30 days?

```sql
SELECT
  DATE_TRUNC('day', CAST(timestamp AS TIMESTAMP)) AS day,
  SUM(metric_value)                               AS new_articles
FROM rss_reader.metrics
WHERE metric_name = 'feed_new_articles'
  AND timestamp > DATEADD('day', -30, NOW())
GROUP BY day
ORDER BY day DESC
```

UI: bar chart or table of daily new article counts. Complements the cycle timeline (which shows per-run counts) with a daily rollup going back further than the 20-run D1 window.

---

## Implementation plan

1. **Recreate sink** as `r2-data-catalog` (see README step 4b) — requires deleting the existing plain-R2 sink first.
2. **Add `src/lib/r2sql.ts`** — thin query client (above).
3. **Update `wrangler.jsonc`** — add `R2_SQL_BUCKET_NAME` var or hardcode; ensure `CF_ACCOUNT_ID` is present (already is).
4. **Update `worker-configuration.d.ts`** — add `R2_SQL_AUTH_TOKEN: string` to secrets (run `pnpm cf-typegen`).
5. **Extend `src/handlers/metrics.tsx`** — add `queryR2Sql` calls alongside the existing D1 `db.batch()`. These can run concurrently with `Promise.all`. Degrade gracefully (empty arrays) if `R2_SQL_AUTH_TOKEN` is not set.
6. **Extend `src/views/metrics.tsx`** — add the three new cards (feed velocity, fetch performance, error rates); the daily new-articles chart can replace or augment the existing cycle timeline for longer time horizons.

**Data latency**: Pipeline rolls files every 300 seconds (5 min), so R2 SQL data lags by up to 5 minutes behind real-time. The D1 cards remain the authoritative source for current-state queries.

**Cost**: R2 SQL is currently free in open beta. R2 storage at this scale (~10 metrics records per feed per cycle, 48 cycles/day, ~200 feeds) is ~100k records/day — negligible storage cost.
