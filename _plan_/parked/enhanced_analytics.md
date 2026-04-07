# Enhanced Analytics

## What's already implemented

**D1-backed (no Pipeline needed):**
- `last_new_item_at` on the feeds table — updated whenever new articles are stored. Surfaces in the Feeds tab as a "Last new item" relative-time column. Immediately answers "is this feed genuinely quiet, or just broken?"
- Poll interval distribution card on the metrics dashboard — shows how backed-off the fleet is across tiers (30m / 1h / 2h / 4h)

**WAE (cycle aggregates):**
- Cycle health card: avg active feeds, due/cycle, checked/cycle, new articles/cycle, failed/cycle
- Per-feed parse success/failure rates and avg duration (7-day window)
- Reads by day

These cover the "is everything running?" question. The remaining gap is **trends over time** — WAE aggregates smooth over individual runs and can't answer per-feed time-series questions.

---

## Motivation for Pipeline

- Fixed schema: limited blobs and doubles per WAE data point
- Free plan: 1 index per data point (can't store both event type and a secondary dimension)
- No per-feed time series: can't ask "which feeds have been silent for 2 weeks?" or "is The Verge publishing less than it used to?"
- No cross-run queries: each cycle's result array is logged but not queryable

Two options for richer analytics: LogPush → Pipeline (automatic log capture) and a direct Pipeline binding (explicit structured writes). They are not mutually exclusive.

---

## Option 1 — LogPush → Cloudflare Pipeline

### How it works

LogPush watches Workers Trace Events (structured logs from `console.log`) and pushes them to a configured destination. With Cloudflare Pipelines now supported as a LogPush destination, the pipeline batches log payloads and writes to R2 as newline-delimited JSON.

No code changes required — every structured log already emitted by the Workflow is captured automatically, including the `feeds: detail` array in the `feed polling cycle complete` event.

### Architecture

```
FeedPollingWorkflow
  └─ logger.info("feed polling cycle complete", { feeds: [...], ... })
        ↓ Workers Trace Events
        ↓ LogPush job → Cloudflare Pipeline
        ↓ R2 bucket (NDJSON, partitioned by date)
        ↓ query via Workers + R2 Select, or external tool
```

### Implementation steps

1. **Create a Pipeline** in the Cloudflare dashboard (or via Wrangler):

   ```bash
   wrangler pipelines create feed-logs --r2-bucket feed-analytics-logs
   ```

   Note the pipeline endpoint URL.

2. **Create a LogPush job** targeting the pipeline:
   - Cloudflare dashboard → Analytics → Logs → LogPush → Add LogPush job
   - Dataset: **Workers Trace Events**
   - Destination: **Cloudflare Pipeline** → select `feed-logs`
   - Filter (optional): `Outcome = ok` to reduce noise from health-check requests

3. **Query** — Workers can read R2 objects directly, or use R2's SQL Select feature:
   ```sql
   SELECT json_extract(payload, '$.message') AS msg,
          json_extract(payload, '$.fields.newArticles') AS newArticles
   FROM r2_object
   WHERE json_extract(payload, '$.fields.workflow') = 'FeedPollingWorkflow'
   ```

### Tradeoffs

|          |                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| **Pros** | Zero code change; captures all logs automatically                                                                  |
| **Cons** | Schema is raw log shape — filtering/parsing required at query time; all Worker logs captured, not just feed events |

---

## Option 2 — Direct Pipeline Binding (recommended for visualisation)

### How it works

Add a `FEED_PIPELINE` binding to the Worker. In the Workflow's `record-cycle` step, write
one structured row per feed result. Pipeline batches these and writes to R2 as Parquet or
JSON. The clean schema makes downstream querying and visualisation straightforward.

### Architecture

```
FeedPollingWorkflow
  └─ record-cycle step
       └─ FEED_PIPELINE.send([{ feedId, status, newItems, cycleId, ... }])
             ↓ Cloudflare Pipeline (batching + buffering)
             ↓ R2 bucket (Parquet or NDJSON, partitioned by date)
             ↓ dashboard queries via Workers + R2 Select
```

### Proposed event schema

One row per feed per cycle:

| Field                  | Type                                    | Description                                         |
| ---------------------- | --------------------------------------- | --------------------------------------------------- |
| `cycleId`              | string                                  | Workflow instance ID — groups all rows from one run |
| `timestamp`            | number                                  | Unix ms — when the cycle completed                  |
| `feedId`               | string                                  | Feed ID                                             |
| `feedTitle`            | string                                  | Feed title or URL                                   |
| `status`               | `"ok"` \| `"not_modified"` \| `"error"` | Fetch outcome                                       |
| `newItems`             | number                                  | New articles stored (0 for non-ok)                  |
| `error`                | string                                  | Error message (empty if not error)                  |
| `checkIntervalMinutes` | number                                  | Interval set after this fetch                       |

### Implementation steps

1. **Create a Pipeline** (same as Option 1 step 1):

   ```bash
   wrangler pipelines create feed-events --r2-bucket feed-analytics-events
   ```

2. **Add binding to `wrangler.jsonc`**:

   ```jsonc
   "pipelines": [
     {
       "pipeline": "feed-events",
       "binding": "FEED_PIPELINE"
     }
   ]
   ```

3. **Run `wrangler types`** to regenerate `worker-configuration.d.ts`.

4. **Write events in `src/workflows/feed_polling.ts`** — in the `record-cycle` step:

   ```typescript
   await step.do("record-cycle", async () => {
     const metrics = createMetrics(this.env.READER_METRICS);
     metrics.recordCycle({ ... }); // WAE aggregate — keep this

     // Per-feed rows to Pipeline
     await this.env.FEED_PIPELINE.send(
       allResults.map((r) => ({
         cycleId: event.instanceId,
         timestamp: Date.now(),
         feedId: r.feedId,
         feedTitle: r.feedTitle,
         status: r.status,
         newItems: r.status === "ok" ? r.newItems : 0,
         error: r.status === "error" ? r.error : "",
       })),
     );
   });
   ```

5. **Query from a Worker** (e.g. a new `/app/analytics` page):
   - List R2 objects for the date range
   - Use R2 Select or read NDJSON, aggregate in-memory
   - Example queries enabled by this schema:
     - **Article velocity trend per feed**: new items per cycle over 30/90 days — is a feed accelerating, slowing, or dead?
     - **Silent feed detection**: feeds with `newItems = 0` for every cycle in the last N days, cross-referenced against `last_new_item_at` — candidates for deactivation review
     - **Backoff trend**: has a feed's `checkIntervalMinutes` been stuck at 240 for weeks? Was it ever chatty?
     - **ETag/304 hit rate**: what fraction of fetches return 304? Low rate = server doesn't support conditional requests; high rate = efficient. Useful if investigating why certain feeds use disproportionate subrequest budget.
     - **Error frequency per feed**: how often does a feed fail, and is it getting worse over time?
     - **New articles per day (personal reading pace)**: complement the WAE reads-by-day card with a "published vs read" gap chart

### Tradeoffs

|          |                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Pros** | Clean schema; per-feed granularity; queryable across runs; works alongside WAE                                                 |
| **Cons** | Small code addition; R2 storage cost (negligible at this scale); Pipeline is a relatively new product — check free plan limits |

---

## Relationship to existing WAE metrics

WAE and a Pipeline are complementary:

|                 | WAE `cycle` event                              | Pipeline feed rows                   |
| --------------- | ---------------------------------------------- | ------------------------------------ |
| **Granularity** | One row per cycle                              | One row per feed per cycle           |
| **Use case**    | Dashboard KPIs (avg checked, avg new articles) | Trend analysis, per-feed debugging   |
| **Retention**   | ~90 days (WAE default)                         | Configurable (R2 object lifecycle)   |
| **Query**       | SQL via CF Analytics Engine API                | R2 Select or Worker-side aggregation |

Keep WAE for the cycle health card. Add the Pipeline when per-feed time series become useful.

---

## Open Questions

- **Free plan Pipeline limits**: verify batch size and R2 write frequency limits before
  committing. As of early 2026, Pipelines are in open beta.
- **R2 Select vs in-Worker aggregation**: R2 Select (SQL over Parquet/JSON in R2) simplifies
  queries but has its own cost model. At low feed counts, reading NDJSON in a Worker and
  aggregating in-memory is probably simpler. At 200 feeds × 48 cycles/day = ~9,600 rows/day
  (~3.5M rows/year) — still tractable for in-memory aggregation over 30-day windows.
- **Dashboard UI**: a new `/app/analytics` tab would surface trends. Could reuse the existing
  table/card components from `src/views/metrics.tsx`. Priority queries to surface first:
  article velocity per feed (sparkline or table), silent feed detection, ETag hit rate.
- **ETag logging**: `fetchAndStoreFeed` already reads the ETag/304 response but doesn't record
  whether a 304 was returned to Pipeline. To get hit rate, add a `wasNotModified: boolean`
  field to the per-feed Pipeline row.
- **`last_new_item_at` sufficiency**: for silence detection the D1 column is enough (already
  implemented). Pipeline only adds value when you want the *history* — e.g. "was this feed
  active 6 months ago and when did it go quiet?"
