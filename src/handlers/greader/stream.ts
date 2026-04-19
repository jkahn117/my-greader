import { Hono, type Context } from "hono";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "../../lib/db";
import { createLogger } from "../../lib/logger";
import {
  decodeContinuation,
  encodeContinuation,
  normalizeItemId,
  toGreaderItemId,
  type ContinuationCursor,
} from "../../lib/crypto";
import { feeds, items, itemState, subscriptions } from "../../db/schema";
import {
  parseStreamId,
  streamContentsSchema,
  streamIdsSchema,
} from "./helpers";
import type { Variables } from "./helpers";

const stream = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Shared condition builder
// ---------------------------------------------------------------------------

type BuildStreamConditionsArgs = {
  streamId: ReturnType<typeof parseStreamId>;
  userId: string;
  excludeRead: boolean;
  cursor: ContinuationCursor | null;
  // ot: unix seconds lower-bound — only items at or newer than this timestamp
  newerThan: number | null;
  db: ReturnType<typeof getDb>;
};

async function buildStreamConditions({
  streamId,
  userId,
  excludeRead,
  cursor,
  newerThan,
  db,
}: BuildStreamConditionsArgs): Promise<SQL<unknown>[]> {
  const conditions: SQL<unknown>[] = [eq(subscriptions.userId, userId)];

  if (streamId.type === "feed") {
    const feed = await db
      .select({ id: feeds.id })
      .from(feeds)
      .where(
        or(eq(feeds.id, streamId.value!), eq(feeds.feedUrl, streamId.value!)),
      )
      .get();
    if (feed) conditions.push(eq(items.feedId, feed.id));
  } else if (streamId.type === "folder") {
    conditions.push(eq(subscriptions.folder, streamId.value!));
  } else if (streamId.type === "starred") {
    conditions.push(eq(itemState.isStarred, 1));
  }

  if (excludeRead) conditions.push(sql`COALESCE(${itemState.isRead}, 0) = 0`);

  // ot (older-than in GReader naming, but means "newer than this epoch seconds"):
  // limits to items published at or after this timestamp — clients use this to
  // only fetch the delta since their last sync rather than re-walking all pages.
  if (newerThan !== null) {
    conditions.push(gte(items.publishedAt, newerThan * 1000));
  }

  // Compound cursor: (publishedAt < cursor.ts) OR (publishedAt = cursor.ts AND id < cursor.id)
  // This correctly pages through items even when multiple items share the same publishedAt.
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
      // Legacy token with no itemId — fall back to timestamp-only
      conditions.push(lt(items.publishedAt, cursor.publishedAt));
    }
  }

  return conditions;
}

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

  const { s, n, xt, c: contToken, ot } = parsed.data;
  const streamId = parseStreamId(s);
  const excludeRead = xt === "user/-/state/com.google/read";
  const cursor = contToken ? decodeContinuation(contToken) : null;

  const conditions = await buildStreamConditions({
    streamId,
    userId,
    excludeRead,
    cursor,
    newerThan: ot ?? null,
    db,
  });

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
    .leftJoin(
      itemState,
      and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(desc(items.publishedAt), desc(items.id))
    .limit(n + 1);

  const hasMore = rows.length > n;
  const page = rows.slice(0, n);
  const lastItem = page.at(-1);
  const continuation =
    hasMore && lastItem?.item.publishedAt && lastItem.item.id
      ? encodeContinuation(lastItem.item.publishedAt, lastItem.item.id)
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
        published: r.item.publishedAt
          ? Math.floor(r.item.publishedAt / 1000)
          : 0,
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

  const { s, n, xt, c: contToken, ot } = parsed.data;
  const streamId = parseStreamId(s);
  const excludeRead = xt === "user/-/state/com.google/read";
  const cursor = contToken ? decodeContinuation(contToken) : null;

  const conditions = await buildStreamConditions({
    streamId,
    userId,
    excludeRead,
    cursor,
    newerThan: ot ?? null,
    db,
  });

  const rows = await db
    .select({ id: items.id, publishedAt: items.publishedAt })
    .from(items)
    .innerJoin(feeds, eq(items.feedId, feeds.id))
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .leftJoin(
      itemState,
      and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(desc(items.publishedAt), desc(items.id))
    .limit(n + 1);

  const hasMore = rows.length > n;
  const page = rows.slice(0, n);
  const lastItem = page.at(-1);
  const continuation =
    hasMore && lastItem?.publishedAt && lastItem.id
      ? encodeContinuation(lastItem.publishedAt, lastItem.id)
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

// ---------------------------------------------------------------------------
// GET|POST /reader/api/0/stream/items/contents
// ---------------------------------------------------------------------------
// Fetches full article content for a specific list of item IDs.
// Clients use this after stream/items/ids to efficiently fetch only the
// articles they don't yet have locally.

type HonoCtx = Context<{ Bindings: Env; Variables: Variables }>;

async function handleStreamItemsContents(c: HonoCtx) {
  const logger = createLogger({
    path: "/reader/api/0/stream/items/contents",
    userId: c.get("userId"),
  });
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  // IDs come as repeated `i` params (GET) or form fields (POST)
  let rawIds: string[] = [];
  if (c.req.method === "POST") {
    const body = await c.req.parseBody({ all: true });
    const i = body["i"];
    rawIds = Array.isArray(i) ? (i as string[]) : i ? [i as string] : [];
  } else {
    rawIds = c.req.queries("i") ?? [];
  }

  const itemIds = rawIds.map(normalizeItemId).filter(Boolean);
  if (itemIds.length === 0)
    return c.json({ id: "user/-/state/com.google/reading-list", items: [] });

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
    .leftJoin(
      itemState,
      and(eq(itemState.itemId, items.id), eq(itemState.userId, userId)),
    )
    .where(and(eq(subscriptions.userId, userId), inArray(items.id, itemIds)));

  logger.info("stream/items/contents", {
    requested: itemIds.length,
    found: rows.length,
  });

  return c.json({
    id: "user/-/state/com.google/reading-list",
    items: rows.map((r) => {
      const categories = ["user/-/state/com.google/reading-list"];
      if (r.isRead) categories.push("user/-/state/com.google/read");
      if (r.isStarred) categories.push("user/-/state/com.google/starred");

      return {
        id: toGreaderItemId(r.item.id),
        title: r.item.title ?? "",
        canonical: [{ href: r.item.url ?? "" }],
        alternate: [{ href: r.item.url ?? "", type: "text/html" }],
        summary: { content: r.item.content ?? "" },
        author: r.item.author ?? "",
        published: r.item.publishedAt
          ? Math.floor(r.item.publishedAt / 1000)
          : 0,
        updated: r.item.publishedAt ? Math.floor(r.item.publishedAt / 1000) : 0,
        origin: {
          streamId: `feed/${r.feedId}`,
          title: r.feedTitle ?? "",
          htmlUrl: r.htmlUrl ?? "",
        },
        categories,
      };
    }),
  });
}

stream.get("/reader/api/0/stream/items/contents", handleStreamItemsContents);
stream.post("/reader/api/0/stream/items/contents", handleStreamItemsContents);

export { stream };
