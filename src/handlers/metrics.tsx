import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { queryWae } from "../lib/wae";
import { feeds } from "../db/schema";
import { App } from "../views/app";
import { CycleStat, MetricsTab, MetricsUnconfigured } from "../views/metrics";

type Variables = { userId: string; email: string };

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /app/metrics — metrics dashboard
// ---------------------------------------------------------------------------

handler.get("/app/metrics", async (c) => {
  const email = c.get("email");
  const logger = createLogger({ path: "/app/metrics", userId: c.get("userId") });

  const accountId = (c.env as unknown as Record<string, string>).CF_ACCOUNT_ID;
  const apiToken = (c.env as unknown as Record<string, string>).CF_API_TOKEN;

  // Render a graceful placeholder if credentials aren't set
  if (!accountId || !apiToken) {
    logger.warn("WAE credentials not configured");
    return c.html(
      <App email={email} active="metrics">
        <MetricsUnconfigured />
      </App>,
    );
  }

  try {
    const [parseResult, readResult, failureResult, cycleResult] = await Promise.all([
      // Parse stats per feed: successes, failures, avg duration, total articles
      queryWae(
        accountId,
        apiToken,
        `
        SELECT
          blob1                          AS feedId,
          countIf(blob2 = 'success')     AS successes,
          countIf(blob2 = 'failure')     AS failures,
          avg(double1)                   AS avgDurationMs,
          sum(double2)                   AS totalArticles
        FROM "rss-reader-data"
        WHERE index1 = 'parse'
          AND timestamp > NOW() - INTERVAL '7' DAY
        GROUP BY feedId
        ORDER BY successes DESC
        LIMIT 100
        `,
      ),
      // Reads grouped by day
      queryWae(
        accountId,
        apiToken,
        `
        SELECT
          toDate(timestamp)  AS date,
          count()            AS reads
        FROM "rss-reader-data"
        WHERE index1 = 'read'
          AND timestamp > NOW() - INTERVAL '7' DAY
        GROUP BY date
        ORDER BY date DESC
        `,
      ),
      // Recent parse failures: feed, timestamp, error message
      queryWae(
        accountId,
        apiToken,
        `
        SELECT
          blob1      AS feedId,
          blob3      AS error,
          timestamp
        FROM "rss-reader-data"
        WHERE index1 = 'parse'
          AND blob2 = 'failure'
          AND timestamp > NOW() - INTERVAL '7' DAY
        ORDER BY timestamp DESC
        LIMIT 50
        `,
      ),
      // Cycle stats: one row per cron run, last 7 days
      queryWae(
        accountId,
        apiToken,
        `
        SELECT
          avg(double1)  AS avgActiveFeeds,
          avg(double2)  AS avgDueFeeds,
          avg(double3)  AS avgCheckedFeeds,
          avg(double4)  AS avgNewArticles,
          avg(double5)  AS avgFailedFeeds,
          count()       AS cycleCount
        FROM "rss-reader-data"
        WHERE index1 = 'cycle'
          AND timestamp > NOW() - INTERVAL '7' DAY
        `,
      ),
    ]);

    const rawParseStats = parseResult.data.map((r) => ({
      feedId: String(r.feedId ?? ""),
      successes: Number(r.successes ?? 0),
      failures: Number(r.failures ?? 0),
      avgDurationMs: Number(r.avgDurationMs ?? 0),
      totalArticles: Number(r.totalArticles ?? 0),
    }));

    // Look up feed titles from D1 for the feeds in the parse results
    const feedIds = rawParseStats.map((r) => r.feedId).filter(Boolean);
    const db = getDb(c.env.DB);
    const feedRows = feedIds.length
      ? await db
          .select({ id: feeds.id, title: feeds.title, feedUrl: feeds.feedUrl })
          .from(feeds)
          .where(inArray(feeds.id, feedIds))
      : [];
    const feedNameMap = new Map(
      feedRows.map((f) => [f.id, f.title ?? f.feedUrl]),
    );

    const parseStats = rawParseStats.map((r) => ({
      ...r,
      feedName: feedNameMap.get(r.feedId) ?? r.feedId,
    }));

    const parseFailures = failureResult.data.map((r) => ({
      feedId: String(r.feedId ?? ""),
      feedName: feedNameMap.get(String(r.feedId ?? "")) ?? String(r.feedId ?? ""),
      error: String(r.error ?? ""),
      timestamp: new Date(String(r.timestamp ?? "")).getTime() || 0,
    }));

    const readsByDay = readResult.data.map((r) => ({
      date: String(r.date ?? ""),
      reads: Number(r.reads ?? 0),
    }));

    const totalReads7d = readsByDay.reduce((sum, r) => sum + r.reads, 0);
    const totalParses7d = parseStats.reduce(
      (sum, r) => sum + r.successes + r.failures,
      0,
    );
    const totalFailures7d = parseStats.reduce((sum, r) => sum + r.failures, 0);

    const cycleRow = cycleResult.data[0];
    const cycleStat: CycleStat | null = cycleRow
      ? {
          cycleCount: Number(cycleRow.cycleCount ?? 0),
          avgActiveFeeds: Number(cycleRow.avgActiveFeeds ?? 0),
          avgDueFeeds: Number(cycleRow.avgDueFeeds ?? 0),
          avgCheckedFeeds: Number(cycleRow.avgCheckedFeeds ?? 0),
          avgNewArticles: Number(cycleRow.avgNewArticles ?? 0),
          avgFailedFeeds: Number(cycleRow.avgFailedFeeds ?? 0),
        }
      : null;

    logger.info("metrics loaded", { totalReads7d, totalParses7d, cycleStat });

    return c.html(
      <App email={email} active="metrics">
        <MetricsTab
          data={{ parseStats, parseFailures, readsByDay, totalReads7d, totalParses7d, totalFailures7d, cycleStat }}
        />
      </App>,
    );
  } catch (err) {
    logger.error("WAE query failed", { err: String(err) });
    return c.html(
      <App email={email} active="metrics">
        <div class="rounded-lg border border-destructive bg-card px-6 py-10 text-center shadow-sm">
          <p class="text-sm font-medium text-destructive">
            Failed to load analytics data
          </p>
          <p class="mt-1 text-sm text-muted-foreground">{String(err)}</p>
        </div>
      </App>,
    );
  }
});

export { handler as metricsHandler };
