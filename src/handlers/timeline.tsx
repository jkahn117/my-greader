import { Hono } from "hono";
import { createActivityReader } from "../feed/activity";
import { createLogger } from "../lib/logger";
import { App } from "../views/app";
import { TimelineTab } from "../views/timeline";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// Renders the User-visible projection supplied by the Activity module.
handler.get("/app/timeline", async (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  const logger = createLogger({ path: "/app/timeline", userId });

  if (!c.env.DB) {
    return c.html(
      <App email={email} active="timeline">
        <div class="rounded-lg border border-destructive bg-card px-6 py-10 text-center shadow-sm">
          <p class="text-sm font-medium text-destructive">
            Database unavailable
          </p>
        </div>
      </App>,
    );
  }

  try {
    const timeline = await createActivityReader(c.env.DB).timeline(userId);

    logger.info("timeline loaded", {
      cycleCount: timeline.cycles.length,
      attemptCount: timeline.cycles.reduce(
        (count, cycle) => count + cycle.attempts.length,
        0,
      ),
      itemCount: timeline.cycles.reduce(
        (count, cycle) => count + cycle.subscribedItemCount,
        0,
      ),
      unattributedItemCount: timeline.unattributedItemCount,
      historyStatus: timeline.historyStatus,
    });

    return c.html(
      <App email={email} active="timeline">
        <TimelineTab timeline={timeline} />
      </App>,
    );
  } catch (err) {
    logger.error(
      "timeline query failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.html(
      <App email={email} active="timeline">
        <div class="rounded-lg border border-destructive bg-card px-6 py-10 text-center shadow-sm">
          <p class="text-sm font-medium text-destructive">
            Failed to load timeline
          </p>
          <p class="mt-1 text-sm text-muted-foreground">{String(err)}</p>
        </div>
      </App>,
    );
  }
});

export { handler as timelineHandler };
