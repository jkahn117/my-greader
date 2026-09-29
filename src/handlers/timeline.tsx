import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import {
  cycleRuns,
  feedPollAttempts,
  feeds,
  items,
  subscriptions,
} from "../db/schema";
import { App } from "../views/app";
import {
  TimelineTab,
  type CycleTimeline,
  type TimelineAttempt,
  type TimelineItem,
} from "../views/timeline";

import type { Variables } from "../types/context";

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
          <p class="text-sm font-medium text-destructive">
            Database unavailable
          </p>
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

    const attemptRows = await db
      .select({
        id: feedPollAttempts.id,
        cycleRunId: feedPollAttempts.cycleRunId,
        feedTitle: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
        outcome: feedPollAttempts.outcome,
        errorClass: feedPollAttempts.errorClass,
        httpStatus: feedPollAttempts.httpStatus,
        parserStatus: feedPollAttempts.parserStatus,
        diagnostic: feedPollAttempts.diagnostic,
      })
      .from(feedPollAttempts)
      .innerJoin(feeds, eq(feedPollAttempts.feedId, feeds.id))
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(
            feedPollAttempts.cycleRunId,
            cycles.map((cycle) => cycle.id),
          ),
        ),
      )
      .orderBy(desc(feedPollAttempts.startedAt));

    // Follow committed foreign keys only. Timestamp proximity is not evidence
    // that a historical Item belongs to a Cycle Run.
    const itemRows = await db
      .select({
        itemId: items.id,
        itemTitle: items.title,
        itemUrl: items.url,
        publishedAt: items.publishedAt,
        feedTitle: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
        attemptId: feedPollAttempts.id,
        cycleRunId: feedPollAttempts.cycleRunId,
      })
      .from(items)
      .innerJoin(
        feedPollAttempts,
        eq(items.firstIngestionAttemptId, feedPollAttempts.id),
      )
      .innerJoin(feeds, eq(items.feedId, feeds.id))
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(
            feedPollAttempts.cycleRunId,
            cycles.map((cycle) => cycle.id),
          ),
        ),
      )
      .orderBy(desc(feedPollAttempts.completedAt), desc(items.id));

    const cycleTimeline: CycleTimeline[] = cycles.map((cycle) => {
      const cycleItems: TimelineItem[] = itemRows
        .filter((row) => row.cycleRunId === cycle.id)
        .map((row) => ({
          itemTitle: row.itemTitle,
          itemUrl: row.itemUrl,
          publishedAt: row.publishedAt,
          feedTitle: row.feedTitle,
          attemptId: row.attemptId,
        }));

      const cycleAttempts: TimelineAttempt[] = attemptRows
        .filter((row) => row.cycleRunId === cycle.id)
        .map((row) => ({
          id: row.id,
          feedTitle: row.feedTitle,
          outcome: row.outcome,
          errorClass: row.errorClass,
          httpStatus: row.httpStatus,
          parserStatus: row.parserStatus,
          diagnostic: row.diagnostic,
        }));

      return {
        cycleId: cycle.id,
        ranAt: cycle.ranAt,
        selectedFeeds: cycle.selectedFeeds,
        checkedFeeds: cycle.checkedFeeds,
        failedFeeds: cycle.failedFeeds,
        skippedFeeds: cycle.skippedFeeds,
        newItems: cycle.newItems,
        triggerReason: cycle.triggerReason,
        status: cycle.status,
        outcome: cycle.outcome,
        attributed: cycle.startedAt != null,
        attempts: cycleAttempts,
        items: cycleItems,
      };
    });

    logger.info("timeline loaded", {
      cycleCount: cycles.length,
      attemptCount: attemptRows.length,
      itemCount: itemRows.length,
    });

    return c.html(
      <App email={email} active="timeline">
        <TimelineTab cycles={cycleTimeline} />
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
