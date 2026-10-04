import { Hono } from "hono";
import { createLogger } from "../lib/logger";
import { createActivityReader } from "../feed/activity";
import type { OverviewResponse } from "../shared/dashboard-api";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /app/api/overview — Overview summary totals for the authenticated user
// ---------------------------------------------------------------------------

handler.get("/app/api/overview", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/overview", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  try {
    const activity = createActivityReader(c.env.DB);
    const summary = await activity.overviewSummary(userId);
    const timezone = c.env.DISPLAY_TIMEZONE || "UTC";

    const response: OverviewResponse = {
      ...summary,
      timezone,
      generatedAt: Date.now(),
    };
    logger.info("overview summary served", { feedCount: summary.feedCount });
    return c.json(response);
  } catch (err) {
    logger.error(
      "overview summary failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to load overview" }, 500);
  }
});

export { handler as dashboardHandler };
