import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { feeds, items, subscriptions, cycleRuns } from "../db/schema";
import { App } from "../views/app";
import { TimelineTab, type CycleTimelineWindow, type TimelineItem } from "../views/timeline";

import type { Variables } from "../types/context";

const CYCLE_MARGIN_MS = 8 * 60 * 60 * 1000;

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

handler.get("/app/timeline", async (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  const logger = createLogger({ path: "/app/timeline", userId });
  const db = getDb(c.env.DB);

  if (!c.env.DB) {
    return c.html(
      <App email={email} active="timeline">
        <div class="rounded-lg border border-destructive bg-card px-6 py-10 text-center shadow-sm">
          <p class="text-sm font-medium text-destructive">Database unavailable</p>
        </div>
      </App>,
    );
  }

  try {
    const cycles = await db
      .select()
      .from(cycleRuns)
      .orderBy(desc(cycleRuns.ranAt))
      .limit(20);

    if (cycles.length === 0) {
      return c.html(
        <App email={email} active="timeline">
          <TimelineTab cycles={[]} />
        </App>,
      );
    }

    const oldestRanAt = cycles[cycles.length - 1].ranAt;
    const fetchStart = oldestRanAt - CYCLE_MARGIN_MS;

    const itemRows = await db
      .select({
        itemId: items.id,
        itemTitle: items.title,
        itemUrl: items.url,
        publishedAt: items.publishedAt,
        fetchedAt: items.fetchedAt,
        feedTitle: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
      })
      .from(items)
      .innerJoin(feeds, eq(items.feedId, feeds.id))
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          gte(items.fetchedAt, fetchStart),
        ),
      )
      .orderBy(desc(items.fetchedAt), desc(items.id));

    const cycleWindows: CycleTimelineWindow[] = cycles.map((cycle, i) => {
      const windowStart = i < cycles.length - 1 ? cycles[i + 1].ranAt : 0;
      const windowEnd = cycle.ranAt;

      const cycleItems: TimelineItem[] = itemRows
        .filter((r) => r.fetchedAt != null && r.fetchedAt >= windowStart && r.fetchedAt <= windowEnd)
        .map((r) => ({
          itemTitle: r.itemTitle,
          itemUrl: r.itemUrl,
          publishedAt: r.publishedAt,
          feedTitle: r.feedTitle,
        }));

      return {
        cycleId: cycle.id,
        ranAt: cycle.ranAt,
        checkedFeeds: cycle.checkedFeeds,
        newItems: cycle.newItems,
        items: cycleItems,
      };
    });

    logger.info("timeline loaded", { cycleCount: cycles.length, itemCount: itemRows.length });

    return c.html(
      <App email={email} active="timeline">
        <TimelineTab cycles={cycleWindows} />
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
          <p class="text-sm font-medium text-destructive">Failed to load timeline</p>
          <p class="mt-1 text-sm text-muted-foreground">{String(err)}</p>
        </div>
      </App>,
    );
  }
});

export { handler as timelineHandler };
