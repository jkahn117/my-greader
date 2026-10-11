/**
 * Activity projections for the dashboard.
 *
 * The module owns bounded D1 reads for the Overview. It applies Subscription
 * visibility and returns projections that dashboard handlers can render
 * without database policy.
 */
import {
  and,
  desc,
  eq,
  gt,
  gte,
  lt,
  isNotNull,
  sql,
} from "drizzle-orm";
import {
  cycleRuns,
  feedPollAttempts,
  feeds,
  items,
  itemState,
  subscriptions,
  type FeedAttemptOutcome,
} from "../db/schema";
import { getDb } from "../lib/db";
import { zonedDays } from "./reading";

const METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const NEEDS_ATTENTION_LIMIT = 8;

export interface AttentionRow {
  feedId: string;
  title: string;
  deactivatedAt: number | null;
  deactivationReason: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  latestOutcome: FeedAttemptOutcome | null;
}

export interface AttentionSummary {
  total: number;
  rateLimited: number;
  failing: number;
  autoDeactivated: number;
  manuallyPaused: number;
}

export interface AttentionItem {
  feedId: string;
  title: string | null;
  kind: "rate_limited" | "failing" | "auto_deactivated";
  detail: string;
}

export interface OverviewSummary {
  feedCount: number;
  activeFeedCount: number;
  deactivatedFeedCount: number;
  newItemsLast7Days: number;
  markedReadLast7Days: number;
  attention: AttentionSummary;
  latestCycle: {
    state: "running" | "completed" | "empty" | "missing" | "unknown";
    ranAt: number | null;
    checkedFeeds: number | null;
  };
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
    state: "running" | "completed" | "empty" | "missing" | "unknown";
    ranAt: number | null;
    checkedFeeds: number | null;
  };
  needsAttention: AttentionItem[];
  manuallyPaused: number;
}

export interface ActivityReader {
  overviewSummary(userId: string): Promise<OverviewSummary>;
  overviewPanels(
    userId: string,
    timestamp: number,
    timezone: string,
  ): Promise<OverviewPanels>;
}

/**
 * Classifies one subscribed feed's attention state from persisted facts:
 * manual pauses are deliberate and never count as failures; rate limiting
 * is reported from the feed's latest check outcome, separately from the
 * persisted error streak.
 */
function classifyAttention(
  row: AttentionRow,
): { kind: AttentionItem["kind"]; detail: string } | "paused" | null {
  if (row.deactivatedAt !== null) {
    if (row.deactivationReason === "manual") return "paused";

    const streak =
      row.consecutiveErrors > 0
        ? `${row.consecutiveErrors} consecutive errors${
            row.lastError ? `: ${row.lastError}` : ""
          }`
        : "no recorded error streak";

    return {
      kind: "auto_deactivated",
      detail: `${streak} · cause unconfirmed`,
    };
  }

  if (row.latestOutcome === "rate_limited") {
    return {
      kind: "rate_limited",
      detail: "HTTP 429 on the latest check · Backoff active",
    };
  }

  if (row.consecutiveErrors > 0) {
    return {
      kind: "failing",
      detail: `${row.consecutiveErrors} consecutive errors${
        row.lastError ? `: ${row.lastError}` : ""
      }`,
    };
  }

  return null;
}

/** Creates the durable Activity read interface used by dashboard adapters. */
export function createActivityReader(
  dbBinding: D1Database,
  now: () => number = Date.now,
): ActivityReader {
  const db = getDb(dbBinding);

  return { overviewSummary, overviewPanels };

  /** Latest recorded cycle-run lifecycle, shared by overview reads. */
  async function latestCycle(): Promise<OverviewSummary["latestCycle"]> {
    const row = await db
      .select()
      .from(cycleRuns)
      .orderBy(desc(cycleRuns.ranAt), desc(cycleRuns.id))
      .limit(1);

    const latest = row[0];

    if (!latest) return { state: "missing", ranAt: null, checkedFeeds: null };

    if (latest.status === null)
      return { state: "unknown", ranAt: latest.ranAt, checkedFeeds: null };

    if (latest.status === "running")
      return {
        state: "running",
        ranAt: latest.ranAt,
        checkedFeeds: latest.checkedFeeds,
      };

    if (latest.outcome === "empty")
      return { state: "empty", ranAt: latest.ranAt, checkedFeeds: 0 };

    return {
      state: "completed",
      ranAt: latest.ranAt,
      checkedFeeds: latest.checkedFeeds,
    };
  }

  /**
   * Every subscribed feed with its persisted health facts and latest
   * recorded check outcome — the raw evidence for attention classification.
   */
  async function attentionRows(userId: string): Promise<AttentionRow[]> {
    const latestPerFeed = db
      .select({
        feedId: feedPollAttempts.feedId,
        latestStartedAt: sql<number>`max(${feedPollAttempts.startedAt})`.as(
          "latest_started_at",
        ),
      })
      .from(feedPollAttempts)
      .groupBy(feedPollAttempts.feedId)
      .as("attention_latest_per_feed");

    const rows = await db
      .select({
        feedId: feeds.id,
        title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title}, ${feeds.feedUrl})`,
        deactivatedAt: feeds.deactivatedAt,
        deactivationReason: feeds.deactivationReason,
        consecutiveErrors: feeds.consecutiveErrors,
        lastError: feeds.lastError,
        latestOutcome: feedPollAttempts.outcome,
      })
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .leftJoin(latestPerFeed, eq(latestPerFeed.feedId, feeds.id))
      .leftJoin(
        feedPollAttempts,
        and(
          eq(feedPollAttempts.feedId, latestPerFeed.feedId),
          eq(feedPollAttempts.startedAt, latestPerFeed.latestStartedAt),
        ),
      )
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(feedPollAttempts.id));

    const latestRows = new Map<string, AttentionRow>();

    for (const row of rows) {
      if (!latestRows.has(row.feedId)) latestRows.set(row.feedId, row);
    }

    return [...latestRows.values()].sort((left, right) =>
      left.feedId.localeCompare(right.feedId),
    );
  }

  /** Aggregates classified attention rows into the summary breakdown. */
  function summarizeAttention(rows: AttentionRow[]): AttentionSummary {
    const summary: AttentionSummary = {
      total: 0,
      rateLimited: 0,
      failing: 0,
      autoDeactivated: 0,
      manuallyPaused: 0,
    };

    for (const row of rows) {
      const kind = classifyAttention(row);

      if (kind === "paused") summary.manuallyPaused++;
      else if (kind !== null) {
        summary.total++;

        if (kind.kind === "rate_limited") summary.rateLimited++;
        else if (kind.kind === "failing") summary.failing++;
        else summary.autoDeactivated++;
      }
    }

    return summary;
  }

  /** Builds User-scoped totals for the React dashboard overview. */
  async function overviewSummary(userId: string): Promise<OverviewSummary> {
    const cutoffMs = now() - METRICS_WINDOW_MS;

    const [feedRows, newItemsRow, readRow, attentionList, cycle] =
      await Promise.all([
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
          .innerJoin(items, eq(itemState.itemId, items.id))
          .innerJoin(
            subscriptions,
            and(
              eq(subscriptions.feedId, items.feedId),
              eq(subscriptions.userId, itemState.userId),
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
        attentionRows(userId),
        latestCycle(),
      ]);

    const feedCount = Number(feedRows[0]?.total ?? 0);
    const deactivatedFeedCount = Number(feedRows[0]?.deactivated ?? 0);

    return {
      feedCount,
      activeFeedCount: feedCount - deactivatedFeedCount,
      deactivatedFeedCount,
      newItemsLast7Days: Number(newItemsRow[0]?.count ?? 0),
      markedReadLast7Days: Number(readRow[0]?.count ?? 0),
      attention: summarizeAttention(attentionList),
      latestCycle: cycle,
    };
  }

  /** Builds the reading, Feed health, Cycle, and attention panels. */
  async function overviewPanels(
    userId: string,
    timestamp: number,
    timezone: string,
  ): Promise<OverviewPanels> {
    const days = zonedDays(timestamp, 7, timezone);
    const cutoffMs = days[0].start;
    const windowEnd = days[days.length - 1].end;

    const latestPerFeed = db
      .select({
        feedId: feedPollAttempts.feedId,
        latestStartedAt: sql<number>`max(${feedPollAttempts.startedAt})`.as(
          "latest_started_at",
        ),
      })
      .from(feedPollAttempts)
      .groupBy(feedPollAttempts.feedId)
      .as("latest_per_feed");

    const [
      readRows,
      topFeedRows,
      latestAttemptRows,
      cycle,
      attentionList,
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
            gte(itemState.readAt, cutoffMs),
            lt(itemState.readAt, windowEnd),
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
            gte(itemState.readAt, cutoffMs),
            lt(itemState.readAt, windowEnd),
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
            eq(feedPollAttempts.startedAt, latestPerFeed.latestStartedAt),
          ),
        )
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.feedId, feedPollAttempts.feedId),
            eq(subscriptions.userId, userId),
          ),
        )
        .orderBy(desc(feedPollAttempts.id)),
      latestCycle(),
      attentionRows(userId),
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

    const daily: ReadingDay[] = days.map(({ date }) => ({
      date,
      count: readCounts.get(date) ?? 0,
    }));

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

    const needsAttention: AttentionItem[] = [];
    let manuallyPaused = 0;

    for (const row of attentionList) {
      const classified = classifyAttention(row);

      if (classified === "paused") {
        manuallyPaused++;
      } else if (
        classified !== null &&
        needsAttention.length < NEEDS_ATTENTION_LIMIT
      ) {
        needsAttention.push({
          feedId: row.feedId,
          title: row.title ?? null,
          kind: classified.kind,
          detail: classified.detail,
        });
      }
    }

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
      needsAttention,
      manuallyPaused,
    };
  }
}
