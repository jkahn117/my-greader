import { Hono } from "hono";
import { createLogger } from "../lib/logger";
import { createActivityReader } from "../feed/activity";
import { createAnalyticsReader } from "../feed/analytics";
import { App } from "../views/app";
import { MetricsTab } from "../views/metrics";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /app/metrics — metrics dashboard
// ---------------------------------------------------------------------------

handler.get("/app/metrics", async (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  const logger = createLogger({ path: "/app/metrics", userId });
  const tz =
    (c.env as unknown as Record<string, string>).DISPLAY_TIMEZONE || "UTC";
  const analyticsEnabled =
    (c.env as unknown as Record<string, string>).ANALYTICS_ENABLED !== "false";
  const cfApiToken = (c.env as unknown as Record<string, string>).CF_API_TOKEN;
  const aeEnabled = analyticsEnabled && !!cfApiToken;
  const accountId = c.env.CF_ACCOUNT_ID;

  try {
    const activity = createActivityReader(c.env.DB);
    const {
      cycles,
      intervalDist,
      totalItems,
      newItems7d,
      readsByDay,
      feedActivity,
    } = await activity.metrics(userId);

    const analytics = createAnalyticsReader({
      accountId,
      apiToken: cfApiToken!,
      enabled: aeEnabled,
    });
    const { feedVelocity, fetchPerf, errorRates, trend30d } =
      await analytics.queryAll(feedActivity);

    logger.info("metrics loaded", {
      cycleCount: cycles.length,
      totalItems,
      newItems7d,
      aeEnabled,
    });

    return c.html(
      <App email={email} active="metrics">
        <MetricsTab
          data={{
            cycles,
            intervalDist,
            totalArticles: totalItems,
            newArticles7d: newItems7d,
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
