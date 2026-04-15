import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { feeds, subscriptions, cycleRuns, items, itemState } from "../db/schema";
import { App } from "../views/app";
import {
  type CycleRun,
  type FeedHealthRow,
  type ReadsByDay,
  MetricsTab,
  MetricsUnconfigured,
} from "../views/metrics";

type Variables = { userId: string; email: string };

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

  try {
    const cutoffMs = Date.now() - SEVEN_DAYS_MS;

    const [
      recentCycles,
      intervalDistRows,
      totalItemsRow,
      newItemsRow,
      feedHealthRows,
      readsByDayRows,
    ] = await db.batch([
      // Last 20 polling cycles for the timeline (most recent first)
      db
        .select()
        .from(cycleRuns)
        .orderBy(desc(cycleRuns.ranAt))
        .limit(20),

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
      deactivatedAt: r.deactivatedAt ?? null,
      checkIntervalMinutes: r.checkIntervalMinutes,
      rateLimited: (r.lastError ?? "").includes("rate limited"),
    }));

    const readsByDay: ReadsByDay[] = readsByDayRows.map((r) => ({
      date: String(r.date ?? ""),
      reads: Number(r.reads ?? 0),
    }));

    logger.info("metrics loaded", {
      cycleCount: cycles.length,
      totalArticles,
      newArticles7d,
      erroringFeeds: feedHealth.filter((f) => f.consecutiveErrors > 0).length,
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
            readsByDay,
            tz,
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
