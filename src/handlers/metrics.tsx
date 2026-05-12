import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { queryAeSql } from "../lib/aesql";
import { feeds, subscriptions, cycleRuns, items, itemState } from "../db/schema";
import { App } from "../views/app";
import {
  type CycleRun,
  type FeedActivityRow,
  type FeedHealthRow,
  type ReadsByDay,
  type FeedVelocityRow,
  type FetchPerfRow,
  type ErrorRateRow,
  type ArticleTrendRow,
  MetricsTab,
  MetricsUnconfigured,
} from "../views/metrics";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// GET /app/metrics — metrics dashboard
// ---------------------------------------------------------------------------

handler.get("/app/metrics", async (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  const logger = createLogger({ path: "/app/metrics", userId });
  const tz = (c.env as unknown as Record<string, string>).DISPLAY_TIMEZONE || "UTC";
  const db = getDb(c.env.DB);

  // Require D1 to be available — if not, nothing works
  if (!c.env.DB) {
    return c.html(
      <App email={email} active="metrics">
        <MetricsUnconfigured />
      </App>,
    );
  }

  const analyticsEnabled = (c.env as unknown as Record<string, string>).ANALYTICS_ENABLED !== "false";
  const cfApiToken = (c.env as unknown as Record<string, string>).CF_API_TOKEN;
  const aeEnabled = analyticsEnabled && !!cfApiToken;
  const accountId = c.env.CF_ACCOUNT_ID;

  try {
    const cutoffMs = Date.now() - SEVEN_DAYS_MS;

    // D1 queries and R2 SQL queries run concurrently
    const [
      [
        recentCycles,
        intervalDistRows,
        totalItemsRow,
        newItemsRow,
        feedHealthRows,
        readsByDayRows,
        feedActivityRows,
      ],
      aeResults,
    ] = await Promise.all([
    db.batch([
      // Last 48 polling cycles (~24h at 30-min intervals) for the timeline
      db
        .select()
        .from(cycleRuns)
        .orderBy(desc(cycleRuns.ranAt))
        .limit(48),

      // Poll interval distribution across active subscribed feeds
      db
        .select({
          checkIntervalMinutes: feeds.checkIntervalMinutes,
          count: sql<number>`count(*)`,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(and(eq(subscriptions.userId, userId), isNull(feeds.deactivatedAt)))
        .groupBy(feeds.checkIntervalMinutes)
        .orderBy(asc(feeds.checkIntervalMinutes)),

      // Total articles in the system
      db
        .select({ count: sql<number>`count(*)` })
        .from(items),

      // Articles fetched in the last 7 days
      db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .where(gt(items.fetchedAt, cutoffMs)),

      // Feed health: all subscribed feeds with their error state
      db
        .select({
          feedId: feeds.id,
          title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
          consecutiveErrors: feeds.consecutiveErrors,
          lastError: feeds.lastError,
          lastFetchedAt: feeds.lastFetchedAt,
          lastNewItemAt: feeds.lastNewItemAt,
          deactivatedAt: feeds.deactivatedAt,
          checkIntervalMinutes: feeds.checkIntervalMinutes,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(feeds.consecutiveErrors), asc(sql`coalesce(${subscriptions.title}, ${feeds.title})`)),

      // Reads per day (last 7 days) from item_state.read_at
      db
        .select({
          date: sql<string>`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`,
          reads: sql<number>`count(*)`,
        })
        .from(itemState)
        .where(
          and(
            eq(itemState.userId, userId),
            eq(itemState.isRead, 1),
            isNotNull(itemState.readAt),
            gt(itemState.readAt, cutoffMs),
          ),
        )
        .groupBy(sql`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`)
        .orderBy(desc(sql`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`))
        .limit(7),

      // Top 15 feeds by new articles in the last 7 days
      db
        .select({
          feedId: subscriptions.feedId,
          title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
          lastNewItemAt: feeds.lastNewItemAt,
          count7d: sql<number>`count(${items.id})`,
        })
        .from(subscriptions)
        .innerJoin(feeds, and(eq(subscriptions.feedId, feeds.id), isNull(feeds.deactivatedAt)))
        .leftJoin(items, and(eq(items.feedId, feeds.id), gt(items.fetchedAt, cutoffMs)))
        .where(eq(subscriptions.userId, userId))
        .groupBy(subscriptions.feedId, subscriptions.title, feeds.title, feeds.feedUrl, feeds.lastNewItemAt)
        .orderBy(desc(sql<number>`count(${items.id})`))
        .limit(15),
    ]),

    // Analytics Engine SQL queries — only when ANALYTICS_ENABLED and CF_API_TOKEN is set.
    // Blob positions: blob1=namespace, blob2=service, blob3=metric_name, blob4=unit, blob5+=dims
    // Each query degrades gracefully to an empty array on failure.
    aeEnabled
      ? Promise.all([
          queryAeSql(
            accountId,
            cfApiToken!,
            `SELECT blob5 AS feedId,
                    SUM(double1) AS total_new_articles,
                    ROUND(AVG(double1), 1) AS avg_per_fetch
             FROM rss_reader_metrics
             WHERE index1 = 'feed_new_articles'
               AND timestamp > NOW() - INTERVAL '30' DAY
             GROUP BY blob5
             ORDER BY total_new_articles DESC
             LIMIT 20`,
          ).catch(() => ({ data: [], meta: [] })),

          queryAeSql(
            accountId,
            cfApiToken!,
            `SELECT blob5 AS feedId,
                    COUNT(*) AS samples,
                    ROUND(AVG(double1)) AS avg_ms,
                    ROUND(MAX(double1)) AS max_ms
             FROM rss_reader_metrics
             WHERE index1 = 'feed_parse_duration_ms'
               AND timestamp > NOW() - INTERVAL '7' DAY
             GROUP BY blob5
             ORDER BY avg_ms DESC
             LIMIT 20`,
          ).catch(() => ({ data: [], meta: [] })),

          queryAeSql(
            accountId,
            cfApiToken!,
            `SELECT blob6 AS httpStatus,
                    COUNT(*) AS occurrences,
                    COUNT(DISTINCT blob5) AS affected_feeds
             FROM rss_reader_metrics
             WHERE index1 = 'feed_fetch_error'
               AND timestamp > NOW() - INTERVAL '7' DAY
             GROUP BY blob6
             ORDER BY occurrences DESC`,
          ).catch(() => ({ data: [], meta: [] })),

          queryAeSql(
            accountId,
            cfApiToken!,
            `SELECT toStartOfDay(timestamp) AS day,
                    SUM(double1) AS new_articles
             FROM rss_reader_metrics
             WHERE index1 = 'feed_new_articles'
               AND timestamp > NOW() - INTERVAL '30' DAY
             GROUP BY day
             ORDER BY day DESC`,
          ).catch(() => ({ data: [], meta: [] })),
        ])
      : Promise.resolve(null),
    ]);

    const cycles: CycleRun[] = recentCycles.map((r) => ({
      id: r.id,
      ranAt: r.ranAt,
      activeFeeds: r.activeFeeds,
      dueFeeds: r.dueFeeds,
      checkedFeeds: r.checkedFeeds,
      newItems: r.newItems,
      failedFeeds: r.failedFeeds,
    }));

    const intervalDist = intervalDistRows.map((r) => ({
      minutes: r.checkIntervalMinutes,
      count: Number(r.count),
    }));

    const totalArticles = Number(totalItemsRow[0]?.count ?? 0);
    const newArticles7d = Number(newItemsRow[0]?.count ?? 0);

    const feedHealth: FeedHealthRow[] = feedHealthRows.map((r) => ({
      feedId: r.feedId,
      title: r.title,
      consecutiveErrors: r.consecutiveErrors,
      lastError: r.lastError ?? null,
      lastFetchedAt: r.lastFetchedAt,
      lastNewItemAt: r.lastNewItemAt ?? null,
      deactivatedAt: r.deactivatedAt ?? null,
      checkIntervalMinutes: r.checkIntervalMinutes,
      rateLimited: (r.lastError ?? "").includes("rate limited"),
    }));

    const readsByDay: ReadsByDay[] = readsByDayRows.map((r) => ({
      date: String(r.date ?? ""),
      reads: Number(r.reads ?? 0),
    }));

    const feedActivity: FeedActivityRow[] = feedActivityRows.map((r) => ({
      feedId: r.feedId,
      title: r.title,
      count7d: Number(r.count7d ?? 0),
      lastNewItemAt: r.lastNewItemAt ?? null,
    }));

    // Build a feedId → title lookup from D1 data so R2 rows can resolve names
    const feedTitleMap = new Map<string, string>();
    for (const r of feedHealth) feedTitleMap.set(r.feedId, r.title);
    for (const r of feedActivity) if (!feedTitleMap.has(r.feedId)) feedTitleMap.set(r.feedId, r.title);

    // Process AE SQL results (null when analytics disabled)
    const [aeVelocityRaw, aePerfRaw, aeErrorRaw, aeTrendRaw] = aeResults ?? [null, null, null, null];

    const feedVelocity: FeedVelocityRow[] = (aeVelocityRaw?.data ?? []).map((row) => ({
      feedId: String(row.feedId ?? ""),
      title: feedTitleMap.get(String(row.feedId ?? "")) ?? String(row.feedId ?? "").slice(0, 8),
      total30d: Number(row.total_new_articles ?? 0),
      avgPerFetch: Number(row.avg_per_fetch ?? 0),
    }));

    const fetchPerf: FetchPerfRow[] = (aePerfRaw?.data ?? []).map((row) => ({
      feedId: String(row.feedId ?? ""),
      title: feedTitleMap.get(String(row.feedId ?? "")) ?? String(row.feedId ?? "").slice(0, 8),
      samples: Number(row.samples ?? 0),
      avgMs: Number(row.avg_ms ?? 0),
      maxMs: Number(row.max_ms ?? 0),
    }));

    const errorRates: ErrorRateRow[] = (aeErrorRaw?.data ?? []).map((row) => ({
      httpStatus: String(row.httpStatus ?? "?"),
      occurrences: Number(row.occurrences ?? 0),
      affectedFeeds: Number(row.affected_feeds ?? 0),
    }));

    const trend30d: ArticleTrendRow[] = (aeTrendRaw?.data ?? []).map((row) => ({
      day: String(row.day ?? "").slice(0, 10),
      newArticles: Number(row.new_articles ?? 0),
    }));

    logger.info("metrics loaded", {
      cycleCount: cycles.length,
      totalArticles,
      newArticles7d,
      erroringFeeds: feedHealth.filter((f) => f.consecutiveErrors > 0).length,
      aeEnabled,
    });

    return c.html(
      <App email={email} active="metrics">
        <MetricsTab
          data={{
            cycles,
            intervalDist,
            totalArticles,
            newArticles7d,
            feedHealth,
            feedActivity,
            readsByDay,
            tz,
            analyticsEnabled: aeEnabled,
            feedVelocity,
            fetchPerf,
            errorRates,
            trend30d,
          }}
        />
      </App>,
    );
  } catch (err) {
    logger.error("metrics query failed", err instanceof Error ? err : { err: String(err) });
    return c.html(
      <App email={email} active="metrics">
        <div class="rounded-lg border border-destructive bg-card px-6 py-10 text-center shadow-sm">
          <p class="text-sm font-medium text-destructive">Failed to load metrics</p>
          <p class="mt-1 text-sm text-muted-foreground">{String(err)}</p>
        </div>
      </App>,
    );
  }
});

export { handler as metricsHandler };
