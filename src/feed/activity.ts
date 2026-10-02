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
  feedId: string;
  feedTitle: string;
  outcome: FeedAttemptOutcome | null;
  errorClass: FeedAttemptErrorClass | null;
  httpStatus: number | null;
  parserStatus: FeedAttemptParserStatus | null;
  diagnostic: string | null;
}

export interface ActivityCycleRun {
  cycleRunId: string;
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
  cycleRuns: ActivityCycleRun[];
  unattributedItemCount: number;
  historyStatus: "available" | "empty" | "unavailable";
}

export interface ActivityReader {
  timeline(userId: string): Promise<ActivityTimeline>;
}

/** Builds a public diagnostic from classified fields instead of stored error text. */
function publicAttemptDiagnostic(attempt: {
  outcome: FeedAttemptOutcome | null;
  errorClass: FeedAttemptErrorClass | null;
  httpStatus: number | null;
}): string | null {
  if (attempt.outcome === "rate_limited") {
    return "HTTP 429, Feed server requested Backoff";
  }
  if (attempt.outcome === "failed") {
    if (attempt.errorClass === "http") {
      return attempt.httpStatus == null
        ? "HTTP request failed"
        : `HTTP ${attempt.httpStatus}`;
    }
    if (attempt.errorClass === "network") {
      return "Network request failed";
    }
    if (attempt.errorClass === "parse") {
      return "Feed content could not be parsed";
    }
    return "Feed polling failed";
  }
  if (attempt.outcome === "skipped") {
    return "Feed was skipped";
  }
  return null;
}

/** Creates the durable Activity read interface used by dashboard adapters. */
export function createActivityReader(dbBinding: D1Database): ActivityReader {
  const db = getDb(dbBinding);

  return { timeline };

  /** Builds a bounded, User-visible Timeline without timestamp inference. */
  async function timeline(userId: string): Promise<ActivityTimeline> {
    const recentCycleRuns = await db
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

    if (recentCycleRuns.length === 0) {
      return {
        cycleRuns: [],
        unattributedItemCount,
        historyStatus: unattributedItemCount > 0 ? "unavailable" : "empty",
      };
    }

    const cycleRunIds = recentCycleRuns.map((cycleRun) => cycleRun.id);
    const attemptRows = await db
      .select({
        id: feedPollAttempts.id,
        cycleRunId: feedPollAttempts.cycleRunId,
        feedId: feedPollAttempts.feedId,
        feedTitle: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
        outcome: feedPollAttempts.outcome,
        errorClass: feedPollAttempts.errorClass,
        httpStatus: feedPollAttempts.httpStatus,
        parserStatus: feedPollAttempts.parserStatus,
      })
      .from(feedPollAttempts)
      .innerJoin(feeds, eq(feedPollAttempts.feedId, feeds.id))
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(feedPollAttempts.cycleRunId, cycleRunIds),
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
          inArray(feedPollAttempts.cycleRunId, cycleRunIds),
        ),
      )
      .orderBy(desc(feedPollAttempts.completedAt), desc(items.id));

    const attemptsByCycleRun = new Map<string, ActivityAttempt[]>();
    for (const row of attemptRows) {
      const attempts = attemptsByCycleRun.get(row.cycleRunId) ?? [];
      attempts.push({
        id: row.id,
        feedId: row.feedId,
        feedTitle: row.feedTitle,
        outcome: row.outcome,
        errorClass: row.errorClass,
        httpStatus: row.httpStatus,
        parserStatus: row.parserStatus,
        diagnostic: publicAttemptDiagnostic(row),
      });
      attemptsByCycleRun.set(row.cycleRunId, attempts);
    }

    const itemsByCycleRun = new Map<string, ActivityItem[]>();
    for (const row of itemRows) {
      const cycleRunItems = itemsByCycleRun.get(row.cycleRunId) ?? [];
      cycleRunItems.push({
        itemTitle: row.itemTitle,
        itemUrl: row.itemUrl,
        publishedAt: row.publishedAt,
        feedTitle: row.feedTitle,
        attemptId: row.attemptId,
      });
      itemsByCycleRun.set(row.cycleRunId, cycleRunItems);
    }

    return {
      cycleRuns: recentCycleRuns.map((cycleRun) => {
        const subscribedItems = itemsByCycleRun.get(cycleRun.id) ?? [];
        return {
          cycleRunId: cycleRun.id,
          ranAt: cycleRun.ranAt,
          globalSelectedFeeds: cycleRun.selectedFeeds,
          globalCheckedFeeds: cycleRun.checkedFeeds,
          globalFailedFeeds: cycleRun.failedFeeds,
          globalSkippedFeeds: cycleRun.skippedFeeds,
          globalNewItems: cycleRun.newItems,
          subscribedItemCount: subscribedItems.length,
          triggerReason: cycleRun.triggerReason,
          status: cycleRun.status,
          outcome: cycleRun.outcome,
          attributed: cycleRun.startedAt != null,
          attempts: attemptsByCycleRun.get(cycleRun.id) ?? [],
          items: subscribedItems,
        };
      }),
      unattributedItemCount,
      historyStatus: "available",
    };
  }
}
