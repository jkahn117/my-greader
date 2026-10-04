/**
 * Activity module — bounded dashboard projections over D1.
 *
 * `createActivity(db)` returns read models for the management dashboard.
 * Each method is scoped to an authenticated user and composes existing
 * domain tables; no business rules are duplicated here beyond the
 * documented metric semantics (see docs/architecture.md).
 */
import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { feeds, items, itemState, subscriptions } from "../db/schema";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface OverviewSummary {
  feedCount: number;
  activeFeedCount: number;
  deactivatedFeedCount: number;
  newItemsLast7Days: number;
  markedReadLast7Days: number;
  feedsNeedingAttention: number;
}

export interface Activity {
  overviewSummary(userId: string, now: number): Promise<OverviewSummary>;
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
  };
}
