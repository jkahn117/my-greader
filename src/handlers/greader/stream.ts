import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../../lib/db";
import { createLogger } from "../../lib/logger";
import { decodeContinuation, encodeContinuation, toGreaderItemId } from "../../lib/crypto";
import { feeds, items, itemState, subscriptions } from "../../db/schema";
import { parseStreamId, streamContentsSchema, streamIdsSchema } from "./helpers";
import type { Variables } from "./helpers";

const stream = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/contents
// ---------------------------------------------------------------------------

stream.get("/reader/api/0/stream/contents", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/stream/contents",
    userId: c.get("userId"),
  });
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const parsed = streamContentsSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Bad request" }, 400);

  const { s, n, xt, c: contToken } = parsed.data;
  const streamId = parseStreamId(s);
  const excludeRead = xt === "user/-/state/com.google/read";
  const cursor = contToken ? decodeContinuation(contToken) : null;

  const conditions = [eq(subscriptions.userId, userId)];

  if (streamId.type === "feed") {
    // value may be feed ID or feed URL
    const feed =
      (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.id, streamId.value!)).get()) ??
      (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.feedUrl, streamId.value!)).get());
    if (feed) conditions.push(eq(items.feedId, feed.id));
  } else if (streamId.type === "folder") {
    conditions.push(eq(subscriptions.folder, streamId.value!));
  } else if (streamId.type === "starred") {
    conditions.push(eq(itemState.isStarred, 1));
  }

  if (excludeRead) {
    // Treat missing item_state rows as unread
    conditions.push(sql`COALESCE(${itemState.isRead}, 0) = 0`);
  }
  if (cursor !== null) conditions.push(lt(items.publishedAt, cursor));

  // Fetch n+1 to detect whether a next page exists
  const rows = await db
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
    .leftJoin(itemState, and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)))
    .where(and(...conditions))
    .orderBy(desc(items.publishedAt))
    .limit(n + 1);

  const hasMore = rows.length > n;
  const page = rows.slice(0, n);
  const lastItem = page.at(-1);
  const continuation =
    hasMore && lastItem?.item.publishedAt
      ? encodeContinuation(lastItem.item.publishedAt)
      : undefined;

  logger.info("stream/contents", { stream: s, count: page.length, hasMore });

  return c.json({
    id: s,
    items: page.map((r) => {
      const categories = ["user/-/state/com.google/reading-list"];
      if (r.isRead) categories.push("user/-/state/com.google/read");
      if (r.isStarred) categories.push("user/-/state/com.google/starred");

      return {
        id: toGreaderItemId(r.item.id),
        title: r.item.title ?? "",
        canonical: [{ href: r.item.url ?? "" }],
        summary: { content: r.item.content ?? "" },
        author: r.item.author ?? "",
        published: r.item.publishedAt ? Math.floor(r.item.publishedAt / 1000) : 0,
        updated: r.item.publishedAt ? Math.floor(r.item.publishedAt / 1000) : 0,
        origin: {
          streamId: `feed/${r.feedId}`,
          title: r.feedTitle ?? "",
          htmlUrl: r.htmlUrl ?? "",
        },
        categories,
      };
    }),
    ...(continuation ? { continuation } : {}),
  });
});

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/items/ids
// ---------------------------------------------------------------------------

stream.get("/reader/api/0/stream/items/ids", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/stream/items/ids",
    userId: c.get("userId"),
  });
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const parsed = streamIdsSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Bad request" }, 400);

  const { s, n, xt, c: contToken } = parsed.data;
  const streamId = parseStreamId(s);
  const excludeRead = xt === "user/-/state/com.google/read";
  const cursor = contToken ? decodeContinuation(contToken) : null;

  const conditions = [eq(subscriptions.userId, userId)];

  if (streamId.type === "feed") {
    const feed =
      (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.id, streamId.value!)).get()) ??
      (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.feedUrl, streamId.value!)).get());
    if (feed) conditions.push(eq(items.feedId, feed.id));
  } else if (streamId.type === "folder") {
    conditions.push(eq(subscriptions.folder, streamId.value!));
  } else if (streamId.type === "starred") {
    conditions.push(eq(itemState.isStarred, 1));
  }

  if (excludeRead) conditions.push(sql`COALESCE(${itemState.isRead}, 0) = 0`);
  if (cursor !== null) conditions.push(lt(items.publishedAt, cursor));

  const rows = await db
    .select({ id: items.id, publishedAt: items.publishedAt })
    .from(items)
    .innerJoin(feeds, eq(items.feedId, feeds.id))
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .leftJoin(itemState, and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)))
    .where(and(...conditions))
    .orderBy(desc(items.publishedAt))
    .limit(n + 1);

  const hasMore = rows.length > n;
  const page = rows.slice(0, n);
  const lastItem = page.at(-1);
  const continuation =
    hasMore && lastItem?.publishedAt
      ? encodeContinuation(lastItem.publishedAt)
      : undefined;

  logger.info("stream/items/ids", { stream: s, count: page.length });

  return c.json({
    itemRefs: page.map((r) => ({
      id: toGreaderItemId(r.id),
      timestampUsec: String((r.publishedAt ?? 0) * 1000),
    })),
    ...(continuation ? { continuation } : {}),
  });
});

export { stream };
