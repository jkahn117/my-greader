/**
 * Activity projections for the dashboard.
 *
 * The module owns bounded D1 reads for Cycle Run history. It follows durable
 * Item-to-attempt relationships and applies current Subscription visibility;
 * dashboard handlers only render the resulting projection.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  cycleRuns,
  feedPollAttempts,
  feeds,
  items,
  subscriptions,
  type FeedAttemptErrorClass,
  type FeedAttemptOutcome,
  type FeedAttemptParserStatus,
} from "../db/schema";
import { getDb } from "../lib/db";

const TIMELINE_CYCLE_LIMIT = 20;

export interface ActivityItem {
  itemTitle: string | null;
  itemUrl: string | null;
  publishedAt: number | null;
  feedTitle: string;
  attemptId: string;
}

export interface ActivityAttempt {
  id: string;
  feedTitle: string;
  outcome: FeedAttemptOutcome | null;
  errorClass: FeedAttemptErrorClass | null;
  httpStatus: number | null;
  parserStatus: FeedAttemptParserStatus | null;
  diagnostic: string | null;
}

export interface ActivityCycle {
  cycleId: string;
  ranAt: number;
  globalSelectedFeeds: number;
  globalCheckedFeeds: number;
  globalFailedFeeds: number;
  globalSkippedFeeds: number;
  globalNewItems: number;
  subscribedItemCount: number;
  triggerReason: "scheduled" | "manual" | "forced" | null;
  status: "running" | "completed" | null;
  outcome: "completed" | "empty" | null;
  attributed: boolean;
  attempts: ActivityAttempt[];
  items: ActivityItem[];
}

export interface ActivityTimeline {
  cycles: ActivityCycle[];
  unattributedItemCount: number;
  historyStatus: "available" | "empty" | "unavailable";
}

export interface ActivityReader {
  timeline(userId: string): Promise<ActivityTimeline>;
}

/** Creates the durable Activity read interface used by dashboard adapters. */
export function createActivityReader(dbBinding: D1Database): ActivityReader {
  const db = getDb(dbBinding);

  return { timeline };

  /** Builds a bounded, User-visible Timeline without timestamp inference. */
  async function timeline(userId: string): Promise<ActivityTimeline> {
    const cycles = await db
      .select()
      .from(cycleRuns)
      .orderBy(desc(cycleRuns.ranAt), desc(cycleRuns.id))
      .limit(TIMELINE_CYCLE_LIMIT);

    const unattributedRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(items)
      .innerJoin(subscriptions, eq(subscriptions.feedId, items.feedId))
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(items.firstIngestionAttemptId),
        ),
      )
      .get();
    const unattributedItemCount = Number(unattributedRow?.count ?? 0);

    if (cycles.length === 0) {
      return {
        cycles: [],
        unattributedItemCount,
        historyStatus: unattributedItemCount > 0 ? "unavailable" : "empty",
      };
    }

    const cycleIds = cycles.map((cycle) => cycle.id);
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
          inArray(feedPollAttempts.cycleRunId, cycleIds),
        ),
      )
      .orderBy(desc(feedPollAttempts.startedAt), desc(feedPollAttempts.id));

    const itemRows = await db
      .select({
        itemTitle: items.title,
        itemUrl: items.url,
        publishedAt: items.publishedAt,
        feedTitle: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
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
          inArray(feedPollAttempts.cycleRunId, cycleIds),
        ),
      )
      .orderBy(desc(feedPollAttempts.completedAt), desc(items.id));

    const attemptsByCycle = new Map<string, ActivityAttempt[]>();
    for (const row of attemptRows) {
      const attempts = attemptsByCycle.get(row.cycleRunId) ?? [];
      attempts.push({
        id: row.id,
        feedTitle: row.feedTitle,
        outcome: row.outcome,
        errorClass: row.errorClass,
        httpStatus: row.httpStatus,
        parserStatus: row.parserStatus,
        diagnostic: row.diagnostic,
      });
      attemptsByCycle.set(row.cycleRunId, attempts);
    }

    const itemsByCycle = new Map<string, ActivityItem[]>();
    for (const row of itemRows) {
      const cycleItems = itemsByCycle.get(row.cycleRunId) ?? [];
      cycleItems.push({
        itemTitle: row.itemTitle,
        itemUrl: row.itemUrl,
        publishedAt: row.publishedAt,
        feedTitle: row.feedTitle,
        attemptId: row.attemptId,
      });
      itemsByCycle.set(row.cycleRunId, cycleItems);
    }

    return {
      cycles: cycles.map((cycle) => {
        const subscribedItems = itemsByCycle.get(cycle.id) ?? [];
        return {
          cycleId: cycle.id,
          ranAt: cycle.ranAt,
          globalSelectedFeeds: cycle.selectedFeeds,
          globalCheckedFeeds: cycle.checkedFeeds,
          globalFailedFeeds: cycle.failedFeeds,
          globalSkippedFeeds: cycle.skippedFeeds,
          globalNewItems: cycle.newItems,
          subscribedItemCount: subscribedItems.length,
          triggerReason: cycle.triggerReason,
          status: cycle.status,
          outcome: cycle.outcome,
          attributed: cycle.startedAt != null,
          attempts: attemptsByCycle.get(cycle.id) ?? [],
          items: subscribedItems,
        };
      }),
      unattributedItemCount,
      historyStatus: "available",
    };
  }
}
