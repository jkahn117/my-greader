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
  or,
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
const NEEDS_ATTENTION_LIMIT = 8;

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

export interface OverviewSummary {
  feedCount: number;
  activeFeedCount: number;
  deactivatedFeedCount: number;
  newItemsLast7Days: number;
  markedReadLast7Days: number;
  feedsNeedingAttention: number;
}

export interface ReadingDay {
  date: string;
  count: number;
}

export interface OverviewPanels {
  reading: {
    windowDays: number;
    daily: ReadingDay[];
    total: number;
    topFeeds: { feedId: string; title: string | null; count: number }[];
  };
  feedHealth: {
    successful: number;
    rateLimited: number;
    failed: number;
    skipped: number;
    running: number;
    empty: number;
    missing: number;
  };
  cycle: {
    state: "running" | "completed" | "empty" | "missing";
    ranAt: number | null;
    checkedFeeds: number | null;
  };
  needsAttention: { feedId: string; title: string | null; reason: string }[];
}

export interface ActivityReader {
  timeline(userId: string): Promise<ActivityTimeline>;
  metrics(userId: string): Promise<ActivityMetrics>;
  overviewSummary(userId: string): Promise<OverviewSummary>;
  overviewPanels(
    userId: string,
    timestamp: number,
    timezone: string,
  ): Promise<OverviewPanels>;
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

  return { timeline, metrics, overviewSummary, overviewPanels };

  /** Builds User-scoped totals for the React dashboard overview. */
  async function overviewSummary(userId: string): Promise<OverviewSummary> {
    const cutoffMs = now() - METRICS_WINDOW_MS;
    const [feedRows, newItemsRow, readRow, attentionRow] = await db.batch([
      db
        .select({
          total: sql<number>`count(*)`,
          deactivated: sql<number>`sum(case when ${feeds.deactivatedAt} is not null then 1 else 0 end)`,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(eq(subscriptions.userId, userId)),
      db
        .select({ count: sql<number>`count(distinct ${items.id})` })
        .from(items)
        .innerJoin(subscriptions, eq(items.feedId, subscriptions.feedId))
        .where(
          and(
            eq(subscriptions.userId, userId),
            gt(items.fetchedAt, cutoffMs),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)` })
        .from(itemState)
        .where(
          and(
            eq(itemState.userId, userId),
            eq(itemState.isRead, 1),
            isNotNull(itemState.readAt),
            gt(itemState.readAt, cutoffMs),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)` })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.userId, userId),
            sql`(${feeds.deactivatedAt} is not null or ${feeds.consecutiveErrors} > 0)`,
          ),
        ),
    ]);

    const feedCount = Number(feedRows[0]?.total ?? 0);
    const deactivatedFeedCount = Number(feedRows[0]?.deactivated ?? 0);
    return {
      feedCount,
      activeFeedCount: feedCount - deactivatedFeedCount,
      deactivatedFeedCount,
      newItemsLast7Days: Number(newItemsRow[0]?.count ?? 0),
      markedReadLast7Days: Number(readRow[0]?.count ?? 0),
      feedsNeedingAttention: Number(attentionRow[0]?.count ?? 0),
    };
  }

  /** Builds the reading, Feed health, Cycle, and attention panels. */
  async function overviewPanels(
    userId: string,
    timestamp: number,
    timezone: string,
  ): Promise<OverviewPanels> {
    const cutoffMs = timestamp - METRICS_WINDOW_MS;
    const latestPerFeed = db
      .select({
        feedId: feedPollAttempts.feedId,
        startedAt: sql<number>`max(${feedPollAttempts.startedAt})`.as(
          "started_at",
        ),
      })
      .from(feedPollAttempts)
      .groupBy(feedPollAttempts.feedId)
      .as("latest_per_feed");

    const [
      readRows,
      topFeedRows,
      latestAttemptRows,
      cycleRow,
      attentionRows,
      subscriptionCountRow,
    ] = await Promise.all([
      db
        .select({ readAt: itemState.readAt })
        .from(itemState)
        .innerJoin(items, eq(itemState.itemId, items.id))
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.userId, itemState.userId),
            eq(subscriptions.feedId, items.feedId),
          ),
        )
        .where(
          and(
            eq(itemState.userId, userId),
            eq(itemState.isRead, 1),
            isNotNull(itemState.readAt),
            gt(itemState.readAt, cutoffMs),
          ),
        ),
      db
        .select({
          feedId: items.feedId,
          title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
          count: sql<number>`count(*)`,
        })
        .from(itemState)
        .innerJoin(items, eq(itemState.itemId, items.id))
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.userId, itemState.userId),
            eq(subscriptions.feedId, items.feedId),
          ),
        )
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(itemState.userId, userId),
            eq(itemState.isRead, 1),
            isNotNull(itemState.readAt),
            gt(itemState.readAt, cutoffMs),
          ),
        )
        .groupBy(items.feedId, subscriptions.title, feeds.title)
        .orderBy(desc(sql`count(*)`))
        .limit(5),
      db
        .select({
          feedId: feedPollAttempts.feedId,
          outcome: feedPollAttempts.outcome,
          newItems: feedPollAttempts.newItems,
          completedAt: feedPollAttempts.completedAt,
        })
        .from(feedPollAttempts)
        .innerJoin(
          latestPerFeed,
          and(
            eq(feedPollAttempts.feedId, latestPerFeed.feedId),
            eq(feedPollAttempts.startedAt, latestPerFeed.startedAt),
          ),
        )
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.feedId, feedPollAttempts.feedId),
            eq(subscriptions.userId, userId),
          ),
        ),
      db.select().from(cycleRuns).orderBy(desc(cycleRuns.ranAt)).limit(1),
      db
        .select({
          feedId: feeds.id,
          title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
          deactivatedAt: feeds.deactivatedAt,
          deactivationReason: feeds.deactivationReason,
          consecutiveErrors: feeds.consecutiveErrors,
          lastError: feeds.lastError,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.userId, userId),
            or(
              isNotNull(feeds.deactivatedAt),
              gt(feeds.consecutiveErrors, 0),
            ),
          ),
        )
        .limit(NEEDS_ATTENTION_LIMIT),
      db
        .select({ count: sql<number>`count(*)` })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),
    ]);

    const dayFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const readCounts = new Map<string, number>();
    for (const row of readRows) {
      const day = dayFormat.format(new Date(row.readAt!));
      readCounts.set(day, (readCounts.get(day) ?? 0) + 1);
    }
    const daily: ReadingDay[] = [];
    for (let offset = 6; offset >= 0; offset--) {
      const day = dayFormat.format(
        new Date(timestamp - offset * 24 * 60 * 60 * 1000),
      );
      daily.push({ date: day, count: readCounts.get(day) ?? 0 });
    }

    const feedHealth: OverviewPanels["feedHealth"] = {
      successful: 0,
      rateLimited: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      empty: 0,
      missing: 0,
    };
    const seenFeeds = new Set<string>();
    for (const attempt of latestAttemptRows) {
      if (seenFeeds.has(attempt.feedId)) continue;
      seenFeeds.add(attempt.feedId);
      if (attempt.completedAt === null) feedHealth.running++;
      else if (attempt.outcome === "skipped") feedHealth.skipped++;
      else if (attempt.outcome === "rate_limited") feedHealth.rateLimited++;
      else if (attempt.outcome === "failed") feedHealth.failed++;
      else if (attempt.outcome === "new_items" && attempt.newItems > 0)
        feedHealth.successful++;
      else feedHealth.empty++;
    }
    feedHealth.missing = Math.max(
      0,
      Number(subscriptionCountRow[0]?.count ?? 0) - seenFeeds.size,
    );

    const latestCycle = cycleRow[0];
    const cycle: OverviewPanels["cycle"] = !latestCycle
      ? { state: "missing", ranAt: null, checkedFeeds: null }
      : latestCycle.status === "running"
        ? {
            state: "running",
            ranAt: latestCycle.ranAt,
            checkedFeeds: latestCycle.checkedFeeds,
          }
        : latestCycle.outcome === "empty"
          ? { state: "empty", ranAt: latestCycle.ranAt, checkedFeeds: 0 }
          : {
              state: "completed",
              ranAt: latestCycle.ranAt,
              checkedFeeds: latestCycle.checkedFeeds,
            };

    return {
      reading: {
        windowDays: 7,
        daily,
        total: readRows.length,
        topFeeds: topFeedRows.map((row) => ({
          feedId: row.feedId,
          title: row.title ?? null,
          count: Number(row.count),
        })),
      },
      feedHealth,
      cycle,
      needsAttention: attentionRows.map((row) => ({
        feedId: row.feedId,
        title: row.title ?? null,
        reason:
          row.deactivatedAt !== null
            ? `Deactivated${row.deactivationReason === "manual" ? " (manual)" : ""}`
            : `${row.consecutiveErrors} consecutive errors${row.lastError ? `: ${row.lastError}` : ""}`,
      })),
    };
  }

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
