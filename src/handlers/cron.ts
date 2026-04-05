import Parser from "rss-parser";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { createMetrics, ParseStatus } from "../lib/metrics";
import { deriveItemId } from "../lib/crypto";
import { feeds, items, itemState, subscriptions } from "../db/schema";

const MAX_CONTENT_BYTES = 50 * 1024; // 50 KB — keeps D1 row sizes manageable
const FETCH_CONCURRENCY = 6;         // matches Cloudflare's simultaneous open connections limit
const ERROR_THRESHOLD = 5;           // consecutive failures before a feed is deactivated

type FeedResult =
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
      return fetchFeeds(env);
    case "0 3 * * 1":
      return purgeOldItems(env);
    default:
      createLogger().warn("unknown cron schedule", { cron: event.cron });
  }
}

// ---------------------------------------------------------------------------
// Feed fetcher — runs every 30 minutes
// ---------------------------------------------------------------------------

export async function fetchFeeds(env: Env): Promise<void> {
  const logger = createLogger({ cron: "fetchFeeds" });
  const db = getDb(env.DB);

  // Each unique active feed is fetched once regardless of subscriber count
  const rows = await db
    .selectDistinct({
      id: feeds.id,
      feedUrl: feeds.feedUrl,
      title: feeds.title,
      htmlUrl: feeds.htmlUrl,
      etag: feeds.etag,
      lastModified: feeds.lastModified,
      lastFetchedAt: feeds.lastFetchedAt,
      consecutiveErrors: feeds.consecutiveErrors,
    })
    .from(feeds)
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .where(isNull(feeds.deactivatedAt))
    // Prioritise never-fetched feeds first, then longest-stale — ensures
    // all feeds rotate through fairly even if the worker times out mid-run
    .orderBy(asc(sql`coalesce(${feeds.lastFetchedAt}, 0)`));

  logger.info("starting feed fetch cycle", { feedCount: rows.length });

  const feedResults: FeedResult[] = [];

  // Process feeds in batches of 6 — respects the simultaneous open connections limit
  for (let i = 0; i < rows.length; i += FETCH_CONCURRENCY) {
    const batch = rows.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((feed) => fetchAndStoreFeed(feed, env)),
    );

    for (let j = 0; j < settled.length; j++) {
      const result = settled[j];
      if (result.status === "fulfilled") {
        const r = result.value;
        if (r.status === "error") {
          logger.error("feed fetch failed", { feedId: r.feedId, feedTitle: r.feedTitle, error: r.error });
        }
        feedResults.push(r);
      } else {
        const error = String(result.reason);
        logger.error("feed fetch threw", { feedId: batch[j].id, feedUrl: batch[j].feedUrl, error });
        feedResults.push({
          feedId: batch[j].id,
          feedTitle: batch[j].title ?? batch[j].feedUrl,
          status: "error",
          error,
        });
      }
    }
  }

  const succeeded = feedResults.filter((r) => r.status === "ok").length;
  const notModified = feedResults.filter((r) => r.status === "not_modified").length;
  const failed = feedResults.filter((r) => r.status === "error").length;
  const newArticles = feedResults.reduce(
    (sum, r) => sum + (r.status === "ok" ? r.newItems : 0),
    0,
  );

  logger.info("feed fetch cycle complete", { succeeded, notModified, failed, newArticles });

  // Optional per-feed detail log — enable with CRON_LOG_DETAIL=true
  if ((env.CRON_LOG_DETAIL as string) === "true") {
    const detail = feedResults.map((r) => {
      if (r.status === "ok") return `${r.feedTitle}: +${r.newItems}`;
      if (r.status === "not_modified") return `${r.feedTitle}: no change`;
      return `${r.feedTitle}: error — ${r.error}`;
    });
    logger.info("feed fetch detail", { feeds: detail });
  }
}

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
  },
  env: Env,
): Promise<FeedResult> {
  const logger = createLogger({ feedId: feed.id, feedUrl: feed.feedUrl });
  const metrics = createMetrics(env.READER_METRICS);
  const db = getDb(env.DB);
  const feedTitle = feed.title ?? feed.feedUrl;

  const start = performance.now();

  // Records a fetch/parse failure, increments consecutive error count,
  // and deactivates the feed once ERROR_THRESHOLD is reached.
  async function recordError(errorMessage: string): Promise<void> {
    const next = feed.consecutiveErrors + 1;
    const deactivate = next >= ERROR_THRESHOLD;
    await db
      .update(feeds)
      .set({
        consecutiveErrors: next,
        lastError: errorMessage,
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
    // Feed unchanged — just record the check time
    await db
      .update(feeds)
      .set({ lastFetchedAt: Date.now() })
      .where(eq(feeds.id, feed.id));
    return { feedId: feed.id, feedTitle, status: "not_modified" };
  }

  if (!response.ok) {
    const errorMessage = `HTTP ${response.status}`;
    logger.warn("feed returned non-OK status", { status: response.status });
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

  await db
    .update(feeds)
    .set({
      title: parsed.title ?? feed.title,
      htmlUrl: parsed.link ?? feed.htmlUrl,
      lastFetchedAt: Date.now(),
      consecutiveErrors: 0,
      lastError: null,
      ...(newEtag != null ? { etag: newEtag } : {}),
      ...(newLastModified != null ? { lastModified: newLastModified } : {}),
    })
    .where(eq(feeds.id, feed.id));

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

  metrics.recordParse({
    feedId: feed.id,
    status: ParseStatus.SUCCESS,
    durationMs: performance.now() - start,
    articleCount: newItems,
  });

  return { feedId: feed.id, feedTitle, status: "ok", newItems };
}

// ---------------------------------------------------------------------------
// Article cleanup — runs weekly (Sundays 03:00 UTC)
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
