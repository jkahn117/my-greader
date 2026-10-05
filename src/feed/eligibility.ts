/**
 * Due-feed eligibility — owns the "which feeds should be polled now" query
 * so the polling Workflow and the manual sync endpoint share one definition.
 *
 * Normal eligibility: a feed is due when it has never been checked or
 * `lastFetchedAt + checkIntervalMinutes` has elapsed.  Forced sync drops the
 * due-time predicate only — deactivated feeds and feeds with no subscriber
 * are excluded in both modes.
 */
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { feeds, subscriptions } from "../db/schema";

export interface DueFeed {
  id: string;
  feedUrl: string;
  title: string | null;
  htmlUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: number | null;
  consecutiveErrors: number;
  checkIntervalMinutes: number;
  lastNewItemAt: number | null;
}

/** Feeds due for a check now; `force` ignores due time but keeps
 *  deactivated/unsubscribed exclusions. */
export async function selectDueFeeds(
  dbBinding: D1Database,
  nowMs: number,
  force = false,
): Promise<DueFeed[]> {
  return await dueFeedsQuery(getDb(dbBinding), nowMs, force);
}

/** The underlying select — exported so callers inside a `db.batch` can
 *  compose it on the same handle. */
export function dueFeedsQuery(
  d: ReturnType<typeof getDb>,
  nowMs: number,
  force: boolean,
) {
  const duePredicate = or(
    isNull(feeds.lastFetchedAt),
    lte(
      sql`${feeds.lastFetchedAt} + ${feeds.checkIntervalMinutes} * 60000`,
      nowMs,
    ),
  );
  return d
    .selectDistinct({
      id: feeds.id,
      feedUrl: feeds.feedUrl,
      title: feeds.title,
      htmlUrl: feeds.htmlUrl,
      etag: feeds.etag,
      lastModified: feeds.lastModified,
      lastFetchedAt: feeds.lastFetchedAt,
      consecutiveErrors: feeds.consecutiveErrors,
      checkIntervalMinutes: feeds.checkIntervalMinutes,
      lastNewItemAt: feeds.lastNewItemAt,
    })
    .from(feeds)
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .where(and(isNull(feeds.deactivatedAt), force ? undefined : duePredicate))
    .orderBy(asc(sql`coalesce(${feeds.lastFetchedAt}, 0)`));
}
