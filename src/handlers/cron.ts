import Parser from "rss-parser";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { tracer } from "../lib/tracer";
import { createMetrics, ParseStatus } from "../lib/metrics";
import { deriveItemId } from "../lib/crypto";
import { feeds, items } from "../db/schema";

const MAX_CONTENT_BYTES = 50 * 1024; // 50 KB — keeps D1 row sizes manageable
const ERROR_THRESHOLD = 5;           // consecutive failures before a feed is deactivated
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 240;    // 4 hours — cap on our own backoff
const MAX_TTL_MINUTES = 1440;        // 24 hours — sanity cap on feed-supplied TTL hints
const BACKOFF_MULTIPLIER = 2;

export type FeedResult =
  | { feedId: string; feedTitle: string; status: "ok"; newItems: number }
  | { feedId: string; feedTitle: string; status: "not_modified" }
  | { feedId: string; feedTitle: string; status: "error"; error: string };

// ---------------------------------------------------------------------------
// Entry point — dispatches on cron schedule string
// ---------------------------------------------------------------------------

export async function scheduled(
  event: ScheduledEvent,
  env: Env,
): Promise<void> {
  switch (event.cron) {
    case "*/30 * * * *":
      return triggerFeedPollingWorkflow(env);
    case "0 3 * * 1":
      return purgeOldItems(env);
    default:
      createLogger().warn("unknown cron schedule", { cron: event.cron });
  }
}

// ---------------------------------------------------------------------------
// Trigger the FeedPollingWorkflow — replaces the old inline fetchFeeds loop
// ---------------------------------------------------------------------------

export async function triggerFeedPollingWorkflow(env: Env): Promise<void> {
  const logger = createLogger({ cron: "triggerFeedPollingWorkflow" });
  const instance = await env.FEED_POLLING_WORKFLOW.create();
  logger.info("feed polling workflow started", { instanceId: instance.id });
}

// ---------------------------------------------------------------------------
// Feed fetcher — called by FeedPollingWorkflow per feed step
// ---------------------------------------------------------------------------

export async function fetchAndStoreFeed(
  feed: {
    id: string;
    feedUrl: string;
    title: string | null;
    htmlUrl: string | null;
    etag: string | null;
    lastModified: string | null;
    lastFetchedAt: number | null;
    consecutiveErrors: number;
    checkIntervalMinutes: number;
    lastNewItemAt: number | null;
  },
  env: Env,
): Promise<FeedResult> {
  // captureAsync wraps the full operation in a named span with timing and error
  // capture. The span is emitted as a structured log entry visible in Logpush.
  return tracer.captureAsync("fetchAndStoreFeed", async (span) => {
    span.annotations.feedId = feed.id;
    return fetchAndStoreFeedInner(feed, env, span);
  });
}

async function fetchAndStoreFeedInner(
  feed: Parameters<typeof fetchAndStoreFeed>[0],
  env: Env,
  span: import("@workers-powertools/tracer").SpanContext,
): Promise<FeedResult> {
  const logger = createLogger({ feedId: feed.id, feedUrl: feed.feedUrl });
  const metrics = createMetrics(env.METRICS_PIPELINE);
  const db = getDb(env.DB);
  const feedTitle = feed.title ?? feed.feedUrl;

  // Tag span with feed metadata for filtering in observability tools
  span.annotations.feedTitle = feedTitle;

  const start = performance.now();

  // Records a fetch/parse failure, increments consecutive error count,
  // and deactivates the feed once ERROR_THRESHOLD is reached.
  // Sets lastFetchedAt so the feed respects checkIntervalMinutes before retry.
  // Does NOT modify checkIntervalMinutes — error backoff is unchanged.
  async function recordError(errorMessage: string): Promise<void> {
    const next = feed.consecutiveErrors + 1;
    const deactivate = next >= ERROR_THRESHOLD;
    await db
      .update(feeds)
      .set({
        consecutiveErrors: next,
        lastError: errorMessage,
        lastFetchedAt: Date.now(), // prevent immediate re-poll on next cycle
        ...(deactivate ? { deactivatedAt: Date.now() } : {}),
      })
      .where(eq(feeds.id, feed.id));
    if (deactivate) {
      logger.warn("feed deactivated after repeated errors", {
        consecutiveErrors: next,
        lastError: errorMessage,
      });
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": "my-greader/1.0 (+https://github.com)",
    Accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };
  if (feed.etag) headers["If-None-Match"] = feed.etag;
  if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

  const response = await fetch(feed.feedUrl, { headers });

  if (response.status === 304) {
    // Feed unchanged — back off
    const newInterval = Math.min(feed.checkIntervalMinutes * BACKOFF_MULTIPLIER, MAX_INTERVAL_MINUTES);
    await db
      .update(feeds)
      .set({ lastFetchedAt: Date.now(), checkIntervalMinutes: newInterval })
      .where(eq(feeds.id, feed.id));
    return { feedId: feed.id, feedTitle, status: "not_modified" };
  }

  if (response.status === 429) {
    // Rate limited — back off without counting as a consecutive error.
    // Respects Retry-After header (seconds or HTTP-date) when present.
    const retryAfter = response.headers.get("Retry-After");
    let backoffMinutes = Math.min(feed.checkIntervalMinutes * BACKOFF_MULTIPLIER, MAX_INTERVAL_MINUTES);
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        backoffMinutes = Math.max(Math.ceil(seconds / 60), backoffMinutes);
      } else {
        const retryMs = new Date(retryAfter).getTime();
        if (!isNaN(retryMs)) {
          backoffMinutes = Math.max(Math.ceil((retryMs - Date.now()) / 60_000), backoffMinutes);
        }
      }
    }
    const errorMessage = "HTTP 429 (rate limited)";
    logger.warn("feed rate limited", { backoffMinutes });
    metrics.recordFetchError({ feedId: feed.id, httpStatus: 429 });
    await db
      .update(feeds)
      .set({
        lastFetchedAt: Date.now(),
        checkIntervalMinutes: backoffMinutes,
        lastError: errorMessage,
        // consecutiveErrors intentionally not incremented — rate limits are transient
      })
      .where(eq(feeds.id, feed.id));
    return { feedId: feed.id, feedTitle, status: "error", error: errorMessage };
  }

  if (!response.ok) {
    const errorMessage = `HTTP ${response.status}`;
    logger.warn("feed returned non-OK status", { status: response.status });
    metrics.recordFetchError({ feedId: feed.id, httpStatus: response.status });
    await recordError(errorMessage);
    return { feedId: feed.id, feedTitle, status: "error", error: errorMessage };
  }

  const xml = await response.text();
  const parser = new Parser();
  let parsed;

  try {
    parsed = await parser.parseString(xml);
  } catch (e) {
    const errorMessage = (e as Error).message;
    metrics.recordParse({
      feedId: feed.id,
      status: ParseStatus.FAILURE,
      durationMs: performance.now() - start,
      error: errorMessage,
    });
    await recordError(errorMessage);
    return { feedId: feed.id, feedTitle, status: "error", error: errorMessage };
  }

  // Capture conditional request headers for future fetches
  const newEtag = response.headers.get("ETag");
  const newLastModified = response.headers.get("Last-Modified");

  // Compute item IDs and content in parallel (crypto only, no D1 subrequests)
  const now = Date.now();
  const itemRows = (
    await Promise.all(
      (parsed.items ?? []).map(async (item) => {
        const guid = item.guid ?? item.link;
        if (!guid) return null;
        return {
          id: await deriveItemId(guid),
          feedId: feed.id,
          title: item.title ?? null,
          url: item.link ?? null,
          content: trimContent(
            item.content ?? item["content:encoded"] ?? item.summary ?? item.contentSnippet ?? "",
            MAX_CONTENT_BYTES,
          ),
          author: item.creator ?? item.author ?? null,
          publishedAt: item.isoDate ? new Date(item.isoDate).getTime() : now,
          fetchedAt: now,
        };
      }),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  // Insert all items in a single D1 batch — one subrequest regardless of count
  let newItems = 0;
  if (itemRows.length > 0) {
    const stmts = itemRows.map((row) => db.insert(items).values(row).onConflictDoNothing());
    // db.batch requires a non-empty tuple — cast needed due to Drizzle's strict overload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batchResults = await db.batch(stmts as unknown as [any, ...any[]]);
    newItems = batchResults.reduce((sum, r) => sum + r.meta.changes, 0);
  }

  // Compute interval from backoff, then floor-raise by feed's TTL hint if present.
  // TTL = "don't check before N minutes" — we respect it even when it exceeds our max.
  const feedTtlMinutes = parsed.ttl
    ? Math.min(Math.round(Number(parsed.ttl)), MAX_TTL_MINUTES)
    : 0;
  const backoffInterval = newItems > 0
    ? MIN_INTERVAL_MINUTES
    : Math.min(feed.checkIntervalMinutes * BACKOFF_MULTIPLIER, MAX_INTERVAL_MINUTES);
  const newInterval = Math.max(backoffInterval, feedTtlMinutes);

  await db
    .update(feeds)
    .set({
      title: parsed.title ?? feed.title,
      htmlUrl: parsed.link ?? feed.htmlUrl,
      lastFetchedAt: now,
      consecutiveErrors: 0,
      lastError: null,
      checkIntervalMinutes: newInterval,
      ...(newItems > 0 ? { lastNewItemAt: now } : {}),
      ...(newEtag != null ? { etag: newEtag } : {}),
      ...(newLastModified != null ? { lastModified: newLastModified } : {}),
    })
    .where(eq(feeds.id, feed.id));

  metrics.recordParse({
    feedId: feed.id,
    status: ParseStatus.SUCCESS,
    durationMs: performance.now() - start,
    articleCount: newItems,
  });

  return { feedId: feed.id, feedTitle, status: "ok", newItems };
}

// ---------------------------------------------------------------------------
// Article cleanup — runs weekly (Mondays 03:00 UTC)
// ---------------------------------------------------------------------------

export async function purgeOldItems(env: Env): Promise<void> {
  const logger = createLogger({ cron: "purgeOldItems" });
  const retentionDays = parseInt(env.ITEM_RETENTION_DAYS ?? "30", 10);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Delete item_state first to satisfy FK constraint, then items
  const stateResult = await env.DB.prepare(
    "DELETE FROM item_state WHERE item_id IN (SELECT id FROM items WHERE fetched_at < ?)",
  )
    .bind(cutoffMs)
    .run();

  const itemResult = await env.DB.prepare(
    "DELETE FROM items WHERE fetched_at < ?",
  )
    .bind(cutoffMs)
    .run();

  logger.info("purged old items", {
    retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    statesDeleted: stateResult.meta.changes,
    itemsDeleted: itemResult.meta.changes,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trims a string to at most `maxBytes` UTF-8 bytes without splitting multibyte chars */
function trimContent(content: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}
