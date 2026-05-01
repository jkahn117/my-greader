import { asc, eq, sql } from "drizzle-orm";
import { feeds, subscriptions } from "./schema";
import type { Db } from "../lib/db";

// Column selection for subscription list queries (feeds_ui + import).
export const subsSelection = {
  id: subscriptions.id,
  feedId: feeds.id,
  // Use the user's custom subscription title if set, otherwise the feed's title
  title: sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
  feedUrl: feeds.feedUrl,
  htmlUrl: feeds.htmlUrl,
  folder: subscriptions.folder,
  lastFetchedAt: feeds.lastFetchedAt,
  consecutiveErrors: feeds.consecutiveErrors,
  lastError: feeds.lastError,
  deactivatedAt: feeds.deactivatedAt,
  checkIntervalMinutes: feeds.checkIntervalMinutes,
  lastNewItemAt: feeds.lastNewItemAt,
};

/** Return all subscriptions for a user, ordered by display title. */
export function selectUserSubscriptions(db: Db, userId: string) {
  return db
    .select(subsSelection)
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(eq(subscriptions.userId, userId))
    .orderBy(asc(sql`coalesce(${subscriptions.title}, ${feeds.title})`));
}
