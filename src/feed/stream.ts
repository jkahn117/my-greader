/**
 * Stream query module — owns GReader stream scope resolution and
 * paginated item queries.
 *
 * `createStreamModule(dbBinding)` returns paginated scope queries and
 * ID lookups. It also exports StreamScope, ItemRow, and toGReaderItem
 * for adapters.
 *
 * GReader handlers become thin adapters: parse HTTP params, call
 * this module, and map results to the JSON wire format.
 */
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "../lib/db";
import { encodeContinuation, toGreaderItemId } from "../lib/crypto";
import type { ContinuationCursor } from "../lib/crypto";
import { feeds, items, itemState, subscriptions } from "../db/schema";
import type { items as itemsTable } from "../db/schema";

export type StreamType = "feed" | "folder" | "all" | "starred";

export interface StreamScope {
  type: StreamType;
  value: string | null;
}

export type ItemRow = {
  item: typeof itemsTable.$inferSelect;
  feedId: string;
  feedTitle: string | null;
  htmlUrl: string | null;
  isRead: number | null;
  isStarred: number | null;
};

export function toGReaderItem(r: ItemRow) {
  const categories = ["user/-/state/com.google/reading-list"];
  if (r.isRead) categories.push("user/-/state/com.google/read");
  if (r.isStarred) categories.push("user/-/state/com.google/starred");

  const publishedSec = r.item.publishedAt
    ? Math.floor(r.item.publishedAt / 1000)
    : 0;

  return {
    id: toGreaderItemId(r.item.id),
    title: r.item.title ?? "",
    canonical: [{ href: r.item.url ?? "" }],
    alternate: [{ href: r.item.url ?? "", type: "text/html" }],
    summary: { content: r.item.content ?? "" },
    author: r.item.author ?? "",
    published: publishedSec,
    updated: publishedSec,
    origin: {
      streamId: `feed/${r.feedId}`,
      title: r.feedTitle ?? "",
      htmlUrl: r.htmlUrl ?? "",
    },
    categories,
  };
}

export interface ScopeParams {
  scope: StreamScope;
  userId: string;
  excludeRead: boolean;
  newerThan: number | null;
  cursor: ContinuationCursor | null;
}

export interface PageResult {
  page: ItemRow[];
  hasMore: boolean;
  continuation?: string;
}

export interface StreamModule {
  queryPage(params: ScopeParams & { limit: number }): Promise<PageResult>;
  queryByIds(params: { ids: string[]; userId: string }): Promise<ItemRow[]>;
}

// Returns a stream query module backed by D1.  All queries filter
// by the user's subscriptions — a client can only see items from
// feeds they are subscribed to.

export function createStreamModule(dbBinding: D1Database): StreamModule {
  const d = getDb(dbBinding);

  async function resolveFeedRef(ref: string) {
    return d
      .select({ id: feeds.id, feedUrl: feeds.feedUrl })
      .from(feeds)
      .where(or(eq(feeds.id, ref), eq(feeds.feedUrl, ref)))
      .get()
      .then((r) => r ?? null);
  }

  async function resolveScope(params: ScopeParams): Promise<SQL<unknown>[]> {
    const { scope, userId, excludeRead, newerThan, cursor } = params;
    const conditions: SQL<unknown>[] = [eq(subscriptions.userId, userId)];

    if (scope.type === "feed") {
      const feed = await resolveFeedRef(scope.value!);
      conditions.push(feed ? eq(items.feedId, feed.id) : sql`0 = 1`);
    } else if (scope.type === "folder") {
      conditions.push(eq(subscriptions.folder, scope.value!));
    } else if (scope.type === "starred") {
      conditions.push(eq(itemState.isStarred, 1));
    }

    if (excludeRead) {
      conditions.push(sql`COALESCE(${itemState.isRead}, 0) = 0`);
    }

    if (newerThan !== null) {
      conditions.push(gte(items.publishedAt, newerThan * 1000));
    }

    if (cursor !== null) {
      if (cursor.itemId) {
        conditions.push(
          or(
            lt(items.publishedAt, cursor.publishedAt),
            and(
              sql`${items.publishedAt} = ${cursor.publishedAt}`,
              lt(items.id, cursor.itemId),
            ),
          ) as SQL<unknown>,
        );
      } else {
        conditions.push(lt(items.publishedAt, cursor.publishedAt));
      }
    }

    return conditions;
  }

  async function queryPage(
    params: ScopeParams & { limit: number },
  ): Promise<PageResult> {
    const { userId, limit } = params;
    const conditions = await resolveScope(params);

    const rows: ItemRow[] = await d
      .select({
        item: items,
        feedId: feeds.id,
        feedTitle: feeds.title,
        htmlUrl: feeds.htmlUrl,
        isRead: itemState.isRead,
        isStarred: itemState.isStarred,
      })
      .from(items)
      .innerJoin(feeds, eq(items.feedId, feeds.id))
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .leftJoin(
        itemState,
        and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)),
      )
      .where(and(...conditions))
      .orderBy(desc(items.publishedAt), desc(items.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const lastItem = page.at(-1);
    const continuation =
      hasMore && lastItem?.item.publishedAt && lastItem.item.id
        ? encodeContinuation(lastItem.item.publishedAt, lastItem.item.id)
        : undefined;

    return { page, hasMore, ...(continuation ? { continuation } : {}) };
  }

  async function queryByIds(params: {
    ids: string[];
    userId: string;
  }): Promise<ItemRow[]> {
    const { ids, userId } = params;

    return d
      .select({
        item: items,
        feedId: feeds.id,
        feedTitle: feeds.title,
        htmlUrl: feeds.htmlUrl,
        isRead: itemState.isRead,
        isStarred: itemState.isStarred,
      })
      .from(items)
      .innerJoin(feeds, eq(items.feedId, feeds.id))
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .leftJoin(
        itemState,
        and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)),
      )
      .where(and(eq(subscriptions.userId, userId), inArray(items.id, ids)));
  }

  return { queryPage, queryByIds };
}
