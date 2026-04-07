# Adaptive Polling

> **Status: implemented** — `drizzle/0002_empty_norman_osborn.sql`, `src/workflows/feed_polling.ts`, `src/handlers/cron.ts`

## Problem

Cloudflare Workers limits subrequests per invocation. Each feed fetch costs 2 subrequests
(HTTP fetch + D1 batch write). With 60+ feeds, fetching all feeds in a single Worker
invocation quickly exceeds the 50-subrequest limit on the free plan.

**Solution: Cloudflare Workflows.** Available on both free and paid plans. Sequential steps
each run in their own Worker invocation with a fresh subrequest budget. This removes the
per-invocation constraint entirely.

Adaptive polling is still valuable with Workflows: there is no point fetching a quiet feed
every 30 minutes when it updates weekly. Backoff reduces unnecessary external HTTP requests
and avoids 429 errors from rate-sensitive feeds.

---

## Architecture

The cron trigger (`*/30 * * * *`) creates a Workflow instance. The Workflow processes feeds
in sequential batches of 20, fetching each batch concurrently within the step.

```
cron → scheduled() → FEED_POLLING_WORKFLOW.create()
  step: "get-due-feeds"      → D1 batch query (due feeds + active count)
  step: "fetch-batch-0"      → up to 20 feeds fetched concurrently
  step: "fetch-batch-1"      → next 20, fresh subrequest budget
  ...
  step: "record-cycle"       → emit WAE cycle event
```

Sequential steps each get a fresh 50-subrequest budget (free plan). Concurrent fan-out
within a step shares that step's budget — 20 feeds × 2 subrequests = 40, safely under 50.

Each step retries automatically on failure before being considered failed.

---

## Backoff Strategy

Multiplier: **2×**, capped at **240 minutes (4 hours)** by our own backoff.
Feed-supplied `<ttl>` can extend the interval beyond 4 hours (capped at 24 hours).

| Event | New `check_interval_minutes` |
|-------|------------------------------|
| New content found | `max(30, feed_ttl)` |
| 304 Not Modified / no new items | `max(min(current × 2, 240), feed_ttl)` |
| Transient error (resolved within step retries) | No change |
| HTTP/parse error (returned as `FeedResult`) | No change |
| Manual reactivation | Reset to **30** |

Progression for a quiet feed with no TTL: `30 → 60 → 120 → 240 → 240 → …`

Four missed cycles to reach max interval (~2 hours). Errors do not affect the interval —
failing feeds retry at the same frequency until `consecutive_errors` hits `ERROR_THRESHOLD`
and the feed is deactivated.

### Feed TTL hints

On a successful parse, `parsed.ttl` (RSS `<ttl>` element, in minutes) is read and used as a
floor on the computed interval. This means:

- A feed with `<ttl>480</ttl>` will not be checked more often than every 8 hours, even if
  new content was just found.
- Our 4-hour backoff cap does not apply when TTL exceeds it.
- TTL values above 1440 minutes (24 hours) are ignored.
- TTL is not available on 304 responses — the interval set on the last successful parse
  carries forward as the backoff base.

---

## Schema

```sql
-- migration: drizzle/0002_empty_norman_osborn.sql
ALTER TABLE feeds ADD check_interval_minutes INTEGER NOT NULL DEFAULT 30;
```

### Feed Selection Query

Only feeds whose interval has elapsed are included in a cycle:

```sql
SELECT DISTINCT ... FROM feeds
INNER JOIN subscriptions ON subscriptions.feed_id = feeds.id
WHERE feeds.deactivated_at IS NULL
  AND (
    feeds.last_fetched_at IS NULL
    OR feeds.last_fetched_at + feeds.check_interval_minutes * 60000 <= ?  -- now
  )
ORDER BY COALESCE(feeds.last_fetched_at, 0) ASC  -- oldest first
```

---

## Analytics Engine — `cycle` Event

| Field | Value |
|-------|-------|
| `index1` | `"cycle"` |
| `double1` | `totalActiveFeeds` |
| `double2` | `dueFeeds` — feeds whose interval had elapsed |
| `double3` | `checkedFeeds` — feeds actually processed |
| `double4` | `newArticles` |
| `double5` | `failedFeeds` |

---

## Capacity Analysis

### Per-step subrequest budget

| Plan | Budget per invocation | Feeds per step (`budget/2 × safety`) | Notes |
|------|-----------------------|--------------------------------------|-------|
| Free | 50 | **20** (40 subreqs used) | 10-subreq safety margin |
| Paid | 1,000 | **~490** (980 subreqs used) | Could process in 1–2 steps |

Current `FEEDS_PER_STEP = 20` is deliberately conservative for the free plan. On a paid plan, it
could be raised to ~490, collapsing a 1,000-feed Workflow from 51 steps to ~3.

### Step count and total feed capacity

There is **no hard cap on the number of sequential steps** in a Cloudflare Workflow. The ceiling
is practical, not a quota: each step adds wall-clock latency before the cycle completes.

| Feeds | Steps (free, 20/step) | Approximate wall time |
|-------|-----------------------|-----------------------|
| 20 | 2 (query + 1 batch) | ~2–5s |
| 100 | 7 | ~7–15s |
| 500 | 27 | ~30–60s |
| 1,000 | 52 | ~1–2 min |
| 5,000 | 252 | ~5–10 min |

A 30-minute cron window comfortably supports thousands of feeds on the free plan.
The paid plan (490/step) handles the same 5,000 feeds in ~12 steps / under a minute.

### Effective load vs. registered feeds: feed chattiness

Adaptive backoff means the **number of feeds checked per cycle is smaller than the total feed
count**. The ratio depends on how frequently feeds publish.

Assumptions used below:
- Chatty feed: publishes daily or more (The Verge, Hacker News) → stays at 30 min
- Normal feed: publishes 2–3×/week → backs off to ~60–120 min within a day or two
- Quiet feed: publishes weekly or less → reaches 240 min cap within a week
- Dead feed: no new content in months → pinned at 240 min (8 checks/day)

| Feed type | Check interval | Checks per day | % of 30-min cycles |
|-----------|---------------|----------------|--------------------|
| Chatty | 30 min | 48 | 100% |
| Normal | 60–120 min | 12–24 | 25–50% |
| Quiet | 240 min | 6 | 12.5% |
| Dead | 240 min | 6 | 12.5% |

For a realistic personal reader with 200 feeds — say 10% chatty, 40% normal, 50% quiet:
- Chatty (20 feeds): 960 fetches/day
- Normal (80 feeds): ~1,280 fetches/day (avg 16/day)
- Quiet (100 feeds): 600 fetches/day
- **Total: ~2,840 fetches/day across 200 feeds** ≈ ~6 feeds due per 30-min cycle on average

That fits easily within a single batch step. Backoff makes the effective per-cycle load
much lower than the registered feed count implies.

### D1 and Worker invocation limits (free plan)

| Metric | Free quota | Estimated usage (200 feeds) |
|--------|-----------|------------------------------|
| D1 reads | 5M/day | ~17K/day (reads per fetch) |
| D1 writes | 100K/day | ~3K/day |
| Worker requests | 100K/day | ~100/day (Workflow steps + cron) |

None of these are the binding constraint at realistic personal-reader scale.

---

## Open Questions / Future Work

- **History-based scheduling** (FreshRSS approach): derive check interval from observed
  posting frequency rather than reactive backoff. More accurate but requires tracking
  per-feed article cadence. Probably overkill for a personal reader.
- **`sy:updatePeriod` / `sy:updateFrequency`**: Syndication namespace extensions; rss-parser
  needs `customFields` config to expose them. Would complement `<ttl>` support.
- **Store TTL in DB**: currently TTL is only applied on successful parse, not on 304. Storing
  it as a column would allow TTL-aware backoff on 304 responses too.
