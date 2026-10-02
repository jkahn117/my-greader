/**
 * Activity projections for the dashboard.
 *
 * The module owns bounded D1 reads for dashboard metrics and Cycle Run
 * history. It applies Subscription visibility and returns projections that
 * dashboard handlers can render without database policy.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  cycleRuns,
  feedPollAttempts,
  feeds,
  items,
  itemState,
  subscriptions,
  type FeedAttemptErrorClass,
  type FeedAttemptOutcome,
  type FeedAttemptParserStatus,
} from "../db/schema";
import { getDb } from "../lib/db";

const TIMELINE_CYCLE_LIMIT = 20;
const METRICS_CYCLE_LIMIT = 48;
const METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface MetricsCycleRun {
  id: string;
  ranAt: number;
  activeFeeds: number;
  dueFeeds: number;
  selectedFeeds: number;
  checkedFeeds: number;
  newItems: number;
  failedFeeds: number;
  skippedFeeds: number;
  status: "running" | "completed" | null;
  outcome: "completed" | "empty" | null;
}

export interface FeedActivityRow {
  feedId: string;
  title: string;
  count7d: number;
  lastNewItemAt: number | null;
}

export interface ReadsByDay {
  date: string;
  reads: number;
}

export interface ActivityMetrics {
  cycles: MetricsCycleRun[];
  intervalDist: { minutes: number; count: number }[];
  totalItems: number;
  newItems7d: number;
  feedActivity: FeedActivityRow[];
  readsByDay: ReadsByDay[];
}

export interface ActivityReader {
  timeline(userId: string): Promise<ActivityTimeline>;
  metrics(userId: string): Promise<ActivityMetrics>;
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
export function createActivityReader(
  dbBinding: D1Database,
  now: () => number = Date.now,
): ActivityReader {
  const db = getDb(dbBinding);

  return { timeline, metrics };

  /** Builds current dashboard metrics with User-scoped activity where needed. */
  async function metrics(userId: string): Promise<ActivityMetrics> {
    const cutoffMs = now() - METRICS_WINDOW_MS;
    const [
      recentCycles,
      intervalRows,
      totalItemsRow,
      newItemsRow,
      readRows,
      feedRows,
    ] = await db.batch([
      db
        .select()
        .from(cycleRuns)
        .orderBy(desc(cycleRuns.ranAt))
        .limit(METRICS_CYCLE_LIMIT),
      db
        .select({
          checkIntervalMinutes: feeds.checkIntervalMinutes,
          count: sql<number>`count(*)`,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(eq(subscriptions.userId, userId), isNull(feeds.deactivatedAt)),
        )
        .groupBy(feeds.checkIntervalMinutes)
        .orderBy(asc(feeds.checkIntervalMinutes)),
      db.select({ count: sql<number>`count(*)` }).from(items),
      db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .where(gt(items.fetchedAt, cutoffMs)),
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
        .groupBy(
          sql`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`,
        )
        .orderBy(
          desc(sql`date(${itemState.readAt} / 1000, 'unixepoch', 'localtime')`),
        )
        .limit(7),
      db
        .select({
          feedId: subscriptions.feedId,
          title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
          lastNewItemAt: feeds.lastNewItemDiscoveredAt,
          count7d: sql<number>`count(${items.id})`,
        })
        .from(subscriptions)
        .innerJoin(
          feeds,
          and(eq(subscriptions.feedId, feeds.id), isNull(feeds.deactivatedAt)),
        )
        .leftJoin(
          items,
          and(eq(items.feedId, feeds.id), gt(items.fetchedAt, cutoffMs)),
        )
        .where(eq(subscriptions.userId, userId))
        .groupBy(
          subscriptions.feedId,
          subscriptions.title,
          feeds.title,
          feeds.feedUrl,
          feeds.lastNewItemDiscoveredAt,
        )
        .orderBy(desc(sql<number>`count(${items.id})`))
        .limit(15),
    ]);

    return {
      cycles: recentCycles.map((cycle) => ({
        id: cycle.id,
        ranAt: cycle.ranAt,
        activeFeeds: cycle.activeFeeds,
        dueFeeds: cycle.dueFeeds,
        selectedFeeds: cycle.selectedFeeds,
        checkedFeeds: cycle.checkedFeeds,
        newItems: cycle.newItems,
        failedFeeds: cycle.failedFeeds,
        skippedFeeds: cycle.skippedFeeds,
        status: cycle.status,
        outcome: cycle.outcome,
      })),
      intervalDist: intervalRows.map((row) => ({
        minutes: row.checkIntervalMinutes,
        count: Number(row.count),
      })),
      totalItems: Number(totalItemsRow[0]?.count ?? 0),
      newItems7d: Number(newItemsRow[0]?.count ?? 0),
      readsByDay: readRows.map((row) => ({
        date: String(row.date ?? ""),
        reads: Number(row.reads ?? 0),
      })),
      feedActivity: feedRows.map((row) => ({
        feedId: row.feedId,
        title: row.title,
        count7d: Number(row.count7d ?? 0),
        lastNewItemAt: row.lastNewItemAt ?? null,
      })),
    };
  }

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
