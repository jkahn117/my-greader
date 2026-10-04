/**
 * Activity module — bounded dashboard projections over D1.
 *
 * `createActivity(db)` returns read models for the management dashboard.
 * Each method is scoped to an authenticated user and composes existing
 * domain tables; no business rules are duplicated here beyond the
 * documented metric semantics (see docs/architecture.md).
 */
import { and, desc, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import {
  cycleRuns,
  feedAttempts,
  feeds,
  items,
  itemState,
  subscriptions,
} from "../db/schema";
import type { FeedListItem, FeedStatus } from "../shared/dashboard-api";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NEEDS_ATTENTION_LIMIT = 8;

export interface OverviewSummary {
  feedCount: number;
  activeFeedCount: number;
  deactivatedFeedCount: number;
  newItemsLast7Days: number;
  markedReadLast7Days: number;
  feedsNeedingAttention: number;
}

/** Classify a subscription's current health from persisted check state.
 *  Order matters: deactivation dominates; a never-checked feed is "new";
 *  the recorded last outcome distinguishes rate-limiting from failures. */
export function classifyFeedStatus(sub: {
  deactivatedAt: number | null;
  lastFetchedAt: number | null;
  lastStatus: string | null;
  consecutiveErrors: number;
}): FeedStatus {
  if (sub.deactivatedAt != null) return "deactivated";
  if (sub.lastFetchedAt == null) return "new";
  if (sub.lastStatus === "rate_limited") return "rate_limited";
  if (sub.consecutiveErrors > 0 || sub.lastStatus === "error") return "failing";
  return "active";
}

export interface ReadingDay {
  /** YYYY-MM-DD in the configured display timezone. */
  date: string;
  count: number;
}

export interface ReadingPanel {
  windowDays: number;
  /** Per-day marked-read totals in display-timezone order, zero-filled;
   *  boundary days stay partial. */
  daily: ReadingDay[];
  total: number;
  topFeeds: { feedId: string; title: string | null; count: number }[];
}

export interface FeedHealthCounts {
  /** Latest check stored new items. */
  successful: number;
  rateLimited: number;
  failed: number;
  /** Deactivated mid-cycle — deliberate skip. */
  skipped: number;
  /** Attempt still in progress. */
  running: number;
  /** Latest check completed but produced nothing (ok-0 or 304). */
  empty: number;
  /** No recorded attempt ever. */
  missing: number;
}

export interface CycleState {
  state: "running" | "completed" | "empty" | "missing";
  ranAt: number | null;
  checkedFeeds: number | null;
}

export interface AttentionItem {
  feedId: string;
  title: string | null;
  reason: string;
}

export interface OverviewPanels {
  reading: ReadingPanel;
  feedHealth: FeedHealthCounts;
  cycle: CycleState;
  needsAttention: AttentionItem[];
}

export interface Activity {
  overviewSummary(userId: string, now: number): Promise<OverviewSummary>;
  overviewPanels(
    userId: string,
    now: number,
    timezone: string,
  ): Promise<OverviewPanels>;
  listFeedRows(userId: string): Promise<FeedListItem[]>;
  /** Single subscription row; null when the user has no subscription
   *  for the feed — the same guard mutations rely on. */
  getFeedRow(userId: string, feedId: string): Promise<FeedListItem | null>;
}

/** Returns the activity read model backed by D1. */
export function createActivity(dbBinding: D1Database): Activity {
  const d = getDb(dbBinding);

  return {
    /**
     * Overview totals: subscription counts (including deactivated feeds),
     * new items ingested in the last 7 days scoped to the user's
     * subscriptions, current read state receipts in the same window, and
     * feeds flagged for attention (deactivated or erroring).
     */
    async overviewSummary(userId, now) {
      const cutoff = now - SEVEN_DAYS_MS;

      const [feedRows, newItemsRow, readRow, attentionRow] = await d.batch([
        d
          .select({
            total: sql<number>`count(*)`,
            deactivated: sql<number>`sum(case when ${feeds.deactivatedAt} is not null then 1 else 0 end)`,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(eq(subscriptions.userId, userId)),

        d
          .select({ count: sql<number>`count(distinct ${items.id})` })
          .from(items)
          .innerJoin(subscriptions, eq(items.feedId, subscriptions.feedId))
          .where(
            and(eq(subscriptions.userId, userId), gt(items.fetchedAt, cutoff)),
          ),

        d
          .select({ count: sql<number>`count(*)` })
          .from(itemState)
          .where(
            and(
              eq(itemState.userId, userId),
              eq(itemState.isRead, 1),
              isNotNull(itemState.readAt),
              gt(itemState.readAt, cutoff),
            ),
          ),

        d
          .select({ count: sql<number>`count(*)` })
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
          ),
      ]);

      const total = Number(feedRows[0]?.total ?? 0);
      const deactivated = Number(feedRows[0]?.deactivated ?? 0);
      return {
        feedCount: total,
        activeFeedCount: total - deactivated,
        deactivatedFeedCount: deactivated,
        newItemsLast7Days: Number(newItemsRow[0]?.count ?? 0),
        markedReadLast7Days: Number(readRow[0]?.count ?? 0),
        feedsNeedingAttention: Number(attentionRow[0]?.count ?? 0),
      };
    },

    /**
     * Overview panels: 7-day marked-read trend + top feeds, per-feed
     * health buckets from each feed's latest attempt, latest cycle
     * lifecycle, and a compact needs-attention list.
     */
    async overviewPanels(userId, now, timezone) {
      const cutoff = now - SEVEN_DAYS_MS;

      // Latest attempt per feed — subquery joined back for the row itself.
      const latestPerFeed = d
        .select({
          feedId: feedAttempts.feedId,
          m: sql<number>`max(${feedAttempts.startedAt})`.as("m"),
        })
        .from(feedAttempts)
        .groupBy(feedAttempts.feedId)
        .as("latest_per_feed");

      const [
        readRows,
        topFeedRows,
        latestAttemptRows,
        runningRow,
        cycleRow,
        attentionRows,
      ] = await Promise.all([
        d
          .select({
            readAt: itemState.readAt,
            feedId: items.feedId,
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
          .where(
            and(
              eq(itemState.userId, userId),
              eq(itemState.isRead, 1),
              isNotNull(itemState.readAt),
              gt(itemState.readAt, cutoff),
            ),
          ),

        d
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
              gt(itemState.readAt, cutoff),
            ),
          )
          .groupBy(items.feedId)
          .orderBy(desc(sql`count(*)`))
          .limit(5),

        // Latest attempt per subscribed feed (any state).
        d
          .select({
            feedId: feedAttempts.feedId,
            status: feedAttempts.status,
            itemsAdded: feedAttempts.itemsAdded,
          })
          .from(feedAttempts)
          .innerJoin(
            latestPerFeed,
            and(
              eq(feedAttempts.feedId, latestPerFeed.feedId),
              eq(feedAttempts.startedAt, latestPerFeed.m),
            ),
          )
          .innerJoin(
            subscriptions,
            and(
              eq(subscriptions.feedId, feedAttempts.feedId),
              eq(subscriptions.userId, userId),
            ),
          ),

        d
          .select({ count: sql<number>`count(*)` })
          .from(feedAttempts)
          .innerJoin(
            subscriptions,
            and(
              eq(subscriptions.feedId, feedAttempts.feedId),
              eq(subscriptions.userId, userId),
            ),
          )
          .where(sql`${feedAttempts.finishedAt} is null`),

        d.select().from(cycleRuns).orderBy(desc(cycleRuns.ranAt)).limit(1),

        d
          .select({
            feedId: feeds.id,
            title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
            deactivatedAt: feeds.deactivatedAt,
            deactivatedReason: feeds.deactivatedReason,
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
      ]);

      // --- Reading: bucket read receipts by display-timezone day.
      const dayFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const byDay = new Map<string, number>();
      for (const r of readRows) {
        const day = dayFmt.format(new Date(r.readAt!));
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
      const daily: ReadingDay[] = [];
      for (let i = 6; i >= 0; i--) {
        const day = dayFmt.format(new Date(now - i * 24 * 60 * 60 * 1000));
        daily.push({ date: day, count: byDay.get(day) ?? 0 });
      }

      // --- Feed health: bucket each feed's latest attempt outcome.
      const health: FeedHealthCounts = {
        successful: 0,
        rateLimited: 0,
        failed: 0,
        skipped: 0,
        running: 0,
        empty: 0,
        missing: 0,
      };
      const seenFeeds = new Set<string>();
      for (const a of latestAttemptRows) {
        if (seenFeeds.has(a.feedId)) continue;
        seenFeeds.add(a.feedId);
        if (a.status == null) health.running++;
        else if (a.status === "skipped") health.skipped++;
        else if (a.status === "rate_limited") health.rateLimited++;
        else if (a.status === "error") health.failed++;
        else if (a.status === "ok" && (a.itemsAdded ?? 0) > 0)
          health.successful++;
        else health.empty++;
      }
      const [subCountRow] = await d
        .select({ count: sql<number>`count(*)` })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId));
      const totalSubs = Number(subCountRow?.count ?? 0);
      health.missing = Math.max(0, totalSubs - seenFeeds.size);

      // --- Cycle lifecycle.
      const running = Number(runningRow[0]?.count ?? 0) > 0;
      const latestCycle = cycleRow[0];
      const cycle: CycleState = running
        ? {
            state: "running",
            ranAt: latestCycle?.ranAt ?? null,
            checkedFeeds: null,
          }
        : !latestCycle
          ? { state: "missing", ranAt: null, checkedFeeds: null }
          : latestCycle.checkedFeeds === 0
            ? {
                state: "empty",
                ranAt: latestCycle.ranAt,
                checkedFeeds: 0,
              }
            : {
                state: "completed",
                ranAt: latestCycle.ranAt,
                checkedFeeds: latestCycle.checkedFeeds,
              };

      const needsAttention: AttentionItem[] = attentionRows.map((r) => ({
        feedId: r.feedId,
        title: r.title ?? null,
        reason:
          r.deactivatedAt != null
            ? `Deactivated${
                r.deactivatedReason === "manual"
                  ? " (manual)"
                  : r.deactivatedReason === "permanent"
                    ? " — permanent failure"
                    : r.deactivatedReason === "transient"
                      ? " — repeated errors"
                      : ""
              }`
            : `${r.consecutiveErrors} consecutive errors${
                r.lastError ? ` — ${r.lastError}` : ""
              }`,
      }));

      return {
        reading: {
          windowDays: 7,
          daily,
          total: readRows.length,
          topFeeds: topFeedRows.map((r) => ({
            feedId: r.feedId,
            title: r.title ?? null,
            count: Number(r.count),
          })),
        },
        feedHealth: health,
        cycle,
        needsAttention,
      };
    },

    /** All of the user's subscriptions with honest health fields —
     *  last successful check, last new item, and next eligibility are
     *  separate facts, never merged into a single "last seen". */
    async listFeedRows(userId) {
      const rows = await feedRowsQuery(d, userId).orderBy(
        subscriptions.folder,
        feeds.title,
      );
      return rows.map(toFeedListItem);
    },

    async getFeedRow(userId, feedId) {
      const row = await feedRowsQuery(d, userId, feedId).get();
      return row ? toFeedListItem(row) : null;
    },
  };
}

/** Shared subscription↔feed selection behind list and detail reads. */
function feedRowsQuery(
  d: ReturnType<typeof getDb>,
  userId: string,
  feedId?: string,
) {
  return d
    .select({
      feedId: feeds.id,
      subscriptionId: subscriptions.id,
      title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
      feedUrl: feeds.feedUrl,
      htmlUrl: feeds.htmlUrl,
      folder: subscriptions.folder,
      deactivatedAt: feeds.deactivatedAt,
      deactivatedReason: feeds.deactivatedReason,
      lastFetchedAt: feeds.lastFetchedAt,
      lastSuccessfulAt: feeds.lastSuccessfulAt,
      lastStatus: feeds.lastStatus,
      lastNewItemAt: feeds.lastNewItemAt,
      consecutiveErrors: feeds.consecutiveErrors,
      lastError: feeds.lastError,
      checkIntervalMinutes: feeds.checkIntervalMinutes,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        feedId != null ? eq(feeds.id, feedId) : undefined,
      ),
    );
}

/** Project one joined subscription+feed row into the API shape. */
function toFeedListItem(r: {
  feedId: string;
  subscriptionId: string;
  title: string | null;
  feedUrl: string;
  htmlUrl: string | null;
  folder: string | null;
  deactivatedAt: number | null;
  deactivatedReason: string | null;
  lastFetchedAt: number | null;
  lastSuccessfulAt: number | null;
  lastStatus: string | null;
  lastNewItemAt: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  checkIntervalMinutes: number;
}): FeedListItem {
  return {
    feedId: r.feedId,
    subscriptionId: r.subscriptionId,
    title: r.title ?? null,
    feedUrl: r.feedUrl,
    htmlUrl: r.htmlUrl,
    folder: r.folder,
    status: classifyFeedStatus(r),
    lastSuccessfulAt: r.lastSuccessfulAt,
    lastCheckedAt: r.lastFetchedAt,
    nextCheckAt:
      r.lastFetchedAt != null
        ? r.lastFetchedAt + r.checkIntervalMinutes * 60_000
        : null,
    lastNewItemAt: r.lastNewItemAt,
    consecutiveErrors: r.consecutiveErrors,
    lastError: r.lastError,
    checkIntervalMinutes: r.checkIntervalMinutes,
    deactivatedAt: r.deactivatedAt,
    deactivatedReason: r.deactivatedReason,
    legacyUncertain: r.deactivatedAt != null && r.deactivatedReason == null,
  };
}
