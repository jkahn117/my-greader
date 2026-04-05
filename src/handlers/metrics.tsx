import { Hono } from "hono";
import { createLogger } from "../lib/logger";
import { queryWae } from "../lib/wae";
import { App } from "../views/app";
import { MetricsTab, MetricsUnconfigured } from "../views/metrics";

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
    const [parseResult, readResult] = await Promise.all([
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
        FROM READER_METRICS
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
        FROM READER_METRICS
        WHERE index1 = 'read'
          AND timestamp > NOW() - INTERVAL '7' DAY
        GROUP BY date
        ORDER BY date DESC
        `,
      ),
    ]);

    const parseStats = parseResult.data.map((r) => ({
      feedId: String(r.feedId ?? ""),
      successes: Number(r.successes ?? 0),
      failures: Number(r.failures ?? 0),
      avgDurationMs: Number(r.avgDurationMs ?? 0),
      totalArticles: Number(r.totalArticles ?? 0),
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

    logger.info("metrics loaded", { totalReads7d, totalParses7d });

    return c.html(
      <App email={email} active="metrics">
        <MetricsTab
          data={{ parseStats, readsByDay, totalReads7d, totalParses7d, totalFailures7d }}
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
