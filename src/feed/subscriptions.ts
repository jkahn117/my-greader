/**
 * Subscription lifecycle module — owns all feed/subscription CRUD.
 *
 * `createSubscriptionLifecycle(db, observe)` returns subscribe,
 * unsubscribe, edit, list, and get.  Canonical-feed upsert and
 * feed resolution by ID or URL are handled internally so protocol
 * adapters (GReader handlers, OPML import) can stay thin.
 *
 * Powertools (logger, metrics) stays in the `SubObserver` adapter
 * that handlers provide — no observability imports here.
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { feeds, subscriptions } from "../db/schema";

export interface SubRow {
  id: string;
  feedId: string;
  title: string | null;
  feedUrl: string;
  htmlUrl: string | null;
  folder: string | null;
  lastFetchedAt: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  deactivatedAt: number | null;
  checkIntervalMinutes: number;
  lastNewItemAt: number | null;
}

export type SubEvent =
  | {
      kind: "subscribed";
      userId: string;
      feedId: string;
      feedUrl: string;
      folder?: string;
    }
  | { kind: "unsubscribed"; userId: string; feedId: string }
  | {
      kind: "subscriptionEdited";
      userId: string;
      feedId: string;
      folder?: string | null;
    };

export interface SubObserver {
  publish(event: SubEvent): void;
}

export interface SubscribeOptions {
  title?: string;
  folder?: string;
  feedTitle?: string;
  feedHtmlUrl?: string;
}

export type SubscribeResult = {
  feedId: string;
  subscriptionId: string;
  created: boolean;
};

export interface EditUpdates {
  title?: string;
  folder?: string | null;
}

export interface SubscriptionLifecycle {
  subscribe(
    userId: string,
    feedUrl: string,
    options?: SubscribeOptions,
  ): Promise<SubscribeResult>;
  unsubscribe(userId: string, feedRef: string): Promise<void>;
  edit(
    userId: string,
    feedRef: string,
    updates: EditUpdates,
  ): Promise<SubRow | null>;
  list(userId: string): Promise<SubRow[]>;
  get(userId: string, feedId: string): Promise<SubRow | null>;
}

// Returns a lifecycle instance backed by D1.  `subscribe()` internally
// upserts the canonical feed row before creating the subscription.
// `unsubscribe()` and `edit()` resolve the feed reference by ID or URL.

export function createSubscriptionLifecycle(
  dbBinding: D1Database,
  observe: SubObserver,
): SubscriptionLifecycle {
  const d = getDb(dbBinding);

  const subSelection = {
    id: subscriptions.id,
    feedId: feeds.id,
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

  return { subscribe, unsubscribe, edit, list, get };

  async function ensureFeed(
    feedUrl: string,
    options?: { title?: string; htmlUrl?: string },
  ) {
    let feed = await d
      .select()
      .from(feeds)
      .where(eq(feeds.feedUrl, feedUrl))
      .get();
    if (!feed) {
      await d
        .insert(feeds)
        .values({
          id: crypto.randomUUID(),
          feedUrl,
          title: options?.title ?? null,
          htmlUrl: options?.htmlUrl ?? null,
        })
        .onConflictDoNothing();
      feed = await d
        .select()
        .from(feeds)
        .where(eq(feeds.feedUrl, feedUrl))
        .get();
    }
    return feed;
  }

  async function resolveFeed(feedRef: string) {
    return d
      .select({ id: feeds.id, feedUrl: feeds.feedUrl })
      .from(feeds)
      .where(or(eq(feeds.id, feedRef), eq(feeds.feedUrl, feedRef)))
      .get();
  }

  async function subscribe(
    userId: string,
    feedUrl: string,
    options?: SubscribeOptions,
  ): Promise<SubscribeResult> {
    const feed = await ensureFeed(feedUrl, {
      title: options?.feedTitle,
      htmlUrl: options?.feedHtmlUrl,
    });
    if (!feed) throw new Error("failed to ensure feed");

    const subId = crypto.randomUUID();
    const result = await d
      .insert(subscriptions)
      .values({
        id: subId,
        userId,
        feedId: feed.id,
        title: options?.title ?? null,
        folder: options?.folder ?? null,
      })
      .onConflictDoNothing();

    const created = result.meta.changes > 0;

    observe.publish({
      kind: "subscribed",
      userId,
      feedId: feed.id,
      feedUrl,
      folder: options?.folder ?? undefined,
    });

    return { feedId: feed.id, subscriptionId: subId, created };
  }

  async function unsubscribe(userId: string, feedRef: string): Promise<void> {
    const feed = await resolveFeed(feedRef);
    if (!feed) return;

    await d
      .delete(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.feedId, feed.id),
        ),
      );

    observe.publish({ kind: "unsubscribed", userId, feedId: feed.id });
  }

  async function edit(
    userId: string,
    feedRef: string,
    updates: EditUpdates,
  ): Promise<SubRow | null> {
    const feed = await resolveFeed(feedRef);
    if (!feed) return null;

    const set: Partial<typeof subscriptions.$inferInsert> = {};
    if (updates.title !== undefined) set.title = updates.title;
    if (updates.folder !== undefined) set.folder = updates.folder;

    if (Object.keys(set).length > 0) {
      await d
        .update(subscriptions)
        .set(set)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, feed.id),
          ),
        );
    }

    observe.publish({
      kind: "subscriptionEdited",
      userId,
      feedId: feed.id,
      folder: updates.folder,
    });

    const row = await d
      .select(subSelection)
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.feedId, feed.id),
        ),
      )
      .get();

    if (!row) throw new Error("subscription not found");
    return row;
  }

  async function list(userId: string): Promise<SubRow[]> {
    return d
      .select(subSelection)
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .where(eq(subscriptions.userId, userId))
      .orderBy(asc(sql`coalesce(${subscriptions.title}, ${feeds.title})`));
  }

  async function get(userId: string, feedId: string): Promise<SubRow | null> {
    const row = await d
      .select(subSelection)
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .where(
        and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)),
      )
      .get();
    return row ?? null;
  }
}
