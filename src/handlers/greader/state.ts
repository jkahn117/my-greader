import { Hono } from "hono";
import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../lib/db";
import { createLogger } from "../../lib/logger";
import { createMetrics } from "../../lib/metrics";
import { normalizeItemId } from "../../lib/crypto";
import { feeds, items, itemState, subscriptions } from "../../db/schema";
import { parseStreamId } from "./helpers";
import type { Variables } from "./helpers";

const state = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /reader/api/0/edit-tag
// ---------------------------------------------------------------------------
// Marks individual items as read/unread or starred/unstarred.

const editTagSchema = z.object({
  // `i` may appear multiple times — parsed with { all: true }
  a: z.string().optional(), // add tag
  r: z.string().optional(), // remove tag
});

state.post("/reader/api/0/edit-tag", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/edit-tag",
    userId: c.get("userId"),
  });
  const metrics = createMetrics(c.env.READER_METRICS);
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const body = await c.req.parseBody({ all: true });
  const parsed = editTagSchema.safeParse(body);
  if (!parsed.success) return c.text("Error", 400);

  const { a, r } = parsed.data;

  // Collect item IDs — may be a single string or array
  const rawIds = Array.isArray(body["i"]) ? (body["i"] as string[]) : [body["i"] as string];
  const itemIds = rawIds.filter(Boolean).map(normalizeItemId);

  if (itemIds.length === 0) return c.text("Error", 400);

  const updates: { isRead?: number; isStarred?: number } = {};
  const addTag = a ?? "";
  const removeTag = r ?? "";

  if (addTag === "user/-/state/com.google/read") updates.isRead = 1;
  if (removeTag === "user/-/state/com.google/read") updates.isRead = 0;
  if (addTag === "user/-/state/com.google/starred") updates.isStarred = 1;
  if (removeTag === "user/-/state/com.google/starred") updates.isStarred = 0;

  if (Object.keys(updates).length === 0) return c.text("OK");

  for (const itemId of itemIds) {
    await db
      .insert(itemState)
      .values({ itemId, userId, isRead: 0, isStarred: 0, ...updates })
      .onConflictDoUpdate({
        target: [itemState.itemId, itemState.userId],
        set: updates,
      });

    if (updates.isRead === 1) {
      metrics.recordRead({ userId, articleId: itemId });
    }
  }

  logger.info("edit-tag", { count: itemIds.length, addTag, removeTag });
  return c.text("OK");
});

// ---------------------------------------------------------------------------
// POST /reader/api/0/mark-all-as-read
// ---------------------------------------------------------------------------

const markAllReadSchema = z.object({
  s: z.string().min(1),
  ts: z.coerce.number().optional(), // timestamp microseconds — mark items older than this
});

state.post("/reader/api/0/mark-all-as-read", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/mark-all-as-read",
    userId: c.get("userId"),
  });
  const metrics = createMetrics(c.env.READER_METRICS);
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const parsed = markAllReadSchema.safeParse(body);
  if (!parsed.success) return c.text("Error", 400);

  const { s, ts } = parsed.data;
  const streamId = parseStreamId(s);

  // ts is in microseconds; convert to ms for comparison against publishedAt
  const cutoffMs = ts ? Math.floor(ts / 1000) : null;

  const itemConditions = [];
  if (cutoffMs !== null) itemConditions.push(lt(items.publishedAt, cutoffMs));

  if (streamId.type === "feed") {
    const feed =
      (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.id, streamId.value!)).get()) ??
      (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.feedUrl, streamId.value!)).get());

    if (!feed) return c.text("OK");
    itemConditions.push(eq(items.feedId, feed.id));
  } else if (streamId.type === "folder") {
    const subFeeds = await db
      .select({ feedId: subscriptions.feedId })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.folder, streamId.value!)));
    const feedIds = subFeeds.map((sf) => sf.feedId);
    if (feedIds.length === 0) return c.text("OK");
    itemConditions.push(inArray(items.feedId, feedIds));
  } else if (streamId.type === "all") {
    const subFeeds = await db
      .select({ feedId: subscriptions.feedId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    const feedIds = subFeeds.map((sf) => sf.feedId);
    if (feedIds.length === 0) return c.text("OK");
    itemConditions.push(inArray(items.feedId, feedIds));
  }

  const targetItems = await db
    .select({ id: items.id })
    .from(items)
    .where(itemConditions.length > 0 ? and(...itemConditions) : undefined);

  const ids = targetItems.map((i) => i.id);
  if (ids.length === 0) return c.text("OK");

  // Bulk upsert in chunks to stay within D1 batch limits
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    for (const itemId of chunk) {
      await db
        .insert(itemState)
        .values({ itemId, userId, isRead: 1, isStarred: 0 })
        .onConflictDoUpdate({
          target: [itemState.itemId, itemState.userId],
          set: { isRead: 1 },
        });

      metrics.recordRead({ userId, articleId: itemId });
    }
  }

  logger.info("mark-all-as-read", { stream: s, count: ids.length });
  return c.text("OK");
});

export { state };
