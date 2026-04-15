# Enhanced Analytics

## What's implemented

**D1-backed dashboard (no Pipeline needed):**
- `last_new_item_at` on the feeds table — updated whenever new articles are stored. Surfaces in the Feeds tab as "Last new item" relative-time. Answers "is this feed quiet or broken?" at a glance.
- `cycle_runs` table — one row per Workflow execution. Written in the `record-cycle` step. Backs the polling cycles timeline (last 20 runs, bar chart + table), aggregate KPIs (avg due/cycle, avg failed/cycle), and the "Last cycle" stat card.
- `item_state.read_at` — stamped when `isRead = 1` is set via the GReader state endpoint. Backs the reads-by-day card (7-day window, grouped by `DISPLAY_TIMEZONE`).
- Poll interval distribution card — shows how backed-off the fleet is across tiers (30m / 1h / 2h / 4h).
- Feed health card — erroring / rate-limited / deactivated feeds surfaced from D1.

**Pipeline (`rss_reader_metrics`) — aggregate metric events via `@workers-powertools/metrics`:**

Named-field Parquet records written to R2 via PipelinesBackend. One record per event, not per feed per cycle. Schema defined in `pipeline-schema.json`.

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

These records land in R2 as Parquet. Not queryable from the Worker dashboard — intended for external analytics (DuckDB, Spark, R2 SQL federation when available).

---

## Remaining gap — per-feed time series

The current Pipeline writes _aggregate_ metric events. The original Option 2 proposed writing _one structured row per feed per cycle_ — enabling:

- **Article velocity trend per feed**: new items per cycle over 30/90 days
- **Silent feed detection over time**: feeds with `newItems = 0` for N consecutive days (cross-reference against `last_new_item_at` for short-term; Pipeline history for long-term)
- **Backoff trend**: was a feed's `checkIntervalMinutes` stuck at 240 for weeks?
- **ETag/304 hit rate**: fraction of fetches returning 304 — measures conditional-request efficiency
- **Published vs read gap**: complement reads-by-day with per-feed publish rate

### What it would take

Add a second pipeline binding (or reuse `METRICS_PIPELINE.send()` directly with a custom payload), and in the `record-cycle` step emit one row per feed result:

```typescript
// One row per feed result per cycle
await this.env.METRICS_PIPELINE.send(
  allResults.map((r) => ({
    event:                "feed_cycle_result",
    cycleId:              event.instanceId,
    timestamp:            new Date().toISOString(),
    feedId:               r.feedId,
    feedTitle:            r.feedTitle,
    status:               r.status,           // "ok" | "not_modified" | "error"
    newItems:             r.status === "ok" ? r.newItems : 0,
    wasNotModified:       r.status === "not_modified",
    checkIntervalMinutes: r.checkIntervalMinutes,
    error:                r.status === "error" ? r.error : "",
  }))
);
```

Schema additions to `pipeline-schema.json`:
- `event`: string
- `cycleId`: string
- `feedTitle`: string
- `newItems`: int64 (or float64)
- `wasNotModified`: bool
- `checkIntervalMinutes`: int64 (or float64)

This can share the same `rss_reader_metrics` pipeline — the `event` field distinguishes per-feed rows from named metric records. Downstream queries filter on `event = 'feed_cycle_result'`.

### Dashboard surface area

A new `/app/analytics` tab (or extension of the metrics tab) could surface:
- Article velocity table: feeds sorted by avg new items/cycle over last 30 days
- Silent feed list: `newItems = 0` for every cycle in the last 14 days (linked to deactivation review)
- Backoff heatmap: which feeds are backed off to 4h and how long have they been there

Priority: low — `last_new_item_at` and the feed health card already catch the actionable cases. The Pipeline data is useful when you want historical trends, not just current state.

---

## Open questions

- **R2 query surface**: R2 SQL Select (if/when available for standard R2 buckets) vs reading Parquet in a Worker vs an external tool. At ~200 feeds × 48 cycles/day the volume is tractable for in-Worker aggregation over 30-day windows.
- **Schema versioning**: if fields are added to `pipeline-schema.json`, existing Parquet files in R2 won't have those columns. Either make all fields optional or version the schema (e.g. prefix path with `v1/`).
- **`last_new_item_at` sufficiency**: for silence detection the D1 column is sufficient for current-state queries. Pipeline history only adds value when you want "when did this feed go quiet?" retrospectively.
