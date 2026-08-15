import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { createAnalyticsReader } from "../feed/analytics";
import {
  feeds,
  subscriptions,
  cycleRuns,
  items,
  itemState,
} from "../db/schema";
import { App } from "../views/app";
import {
  type CycleRun,
  type FeedActivityRow,
  type ReadsByDay,
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
  const tz =
    (c.env as unknown as Record<string, string>).DISPLAY_TIMEZONE || "UTC";
  const db = getDb(c.env.DB);

  // Require D1 to be available — if not, nothing works
  if (!c.env.DB) {
    return c.html(
      <App email={email} active="metrics">
        <MetricsUnconfigured />
      </App>,
    );
  }

  const analyticsEnabled =
    (c.env as unknown as Record<string, string>).ANALYTICS_ENABLED !== "false";
  const cfApiToken = (c.env as unknown as Record<string, string>).CF_API_TOKEN;
  const aeEnabled = analyticsEnabled && !!cfApiToken;
  const accountId = c.env.CF_ACCOUNT_ID;

  try {
    const cutoffMs = Date.now() - SEVEN_DAYS_MS;

    const [
      recentCycles,
      intervalDistRows,
      totalItemsRow,
      newItemsRow,
      readsByDayRows,
      feedActivityRows,
    ] = await db.batch([
      // Last 48 polling cycles (~24h at 30-min intervals) for the timeline
      db.select().from(cycleRuns).orderBy(desc(cycleRuns.ranAt)).limit(48),

      // Poll interval distribution across active subscribed feeds
      db
        .select({
          checkIntervalMinutes: feeds.checkIntervalMinutes,
          count: sql<number>`count(*)`,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(eq(subscriptions.userId, userId), isNull(feeds.deactivatedAt)),
        )
        .groupBy(feeds.checkIntervalMinutes)
        .orderBy(asc(feeds.checkIntervalMinutes)),

      // Total articles in the system
      db.select({ count: sql<number>`count(*)` }).from(items),

      // Articles fetched in the last 7 days
      db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .where(gt(items.fetchedAt, cutoffMs)),

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
        .groupBy(
          sql`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`,
        )
        .orderBy(
          desc(
            sql`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`,
          ),
        )
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
        .innerJoin(
          feeds,
          and(
            eq(subscriptions.feedId, feeds.id),
            isNull(feeds.deactivatedAt),
          ),
        )
        .leftJoin(
          items,
          and(eq(items.feedId, feeds.id), gt(items.fetchedAt, cutoffMs)),
        )
        .where(eq(subscriptions.userId, userId))
        .groupBy(
          subscriptions.feedId,
          subscriptions.title,
          feeds.title,
          feeds.feedUrl,
          feeds.lastNewItemAt,
        )
        .orderBy(desc(sql<number>`count(${items.id})`))
        .limit(15),
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

    const analytics = createAnalyticsReader({
      accountId,
      apiToken: cfApiToken!,
      enabled: aeEnabled,
    });
    const { feedVelocity, fetchPerf, errorRates, trend30d } =
      await analytics.queryAll(feedActivity);

    logger.info("metrics loaded", {
      cycleCount: cycles.length,
      totalArticles,
      newArticles7d,
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
    logger.error(
      "metrics query failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.html(
      <App email={email} active="metrics">
        <div class="rounded-lg border border-destructive bg-card px-6 py-10 text-center shadow-sm">
          <p class="text-sm font-medium text-destructive">
            Failed to load metrics
          </p>
          <p class="mt-1 text-sm text-muted-foreground">{String(err)}</p>
        </div>
      </App>,
    );
  }
});

export { handler as metricsHandler };
