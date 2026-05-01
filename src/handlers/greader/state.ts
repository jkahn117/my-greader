import { Hono } from "hono";
import { eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../lib/db";
import { createLogger } from "../../lib/logger";
import { createMetrics } from "../../lib/metrics";
import { normalizeItemId } from "../../lib/crypto";
import { feeds, items, itemState } from "../../db/schema";
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
  const metrics = createMetrics(c.env.METRICS_PIPELINE, c.env.ANALYTICS_ENABLED !== "false");
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const body = await c.req.parseBody({ all: true });
  const parsed = editTagSchema.safeParse(body);
  if (!parsed.success) return c.text("Error", 400);

  const { a, r } = parsed.data;

  // Collect item IDs — may be a single string or array
  const rawIds = Array.isArray(body["i"])
    ? (body["i"] as string[])
    : [body["i"] as string];
  const itemIds = rawIds.filter(Boolean).map(normalizeItemId);

  if (itemIds.length === 0) return c.text("Error", 400);

  const updates: { isRead?: number; isStarred?: number } = {};
  const addTag = a ?? "";
  const removeTag = r ?? "";

  if (addTag === "user/-/state/com.google/read") updates.isRead = 1;
  if (removeTag === "user/-/state/com.google/read") updates.isRead = 0;
  if (addTag === "user/-/state/com.google/starred") updates.isStarred = 1;
  if (removeTag === "user/-/state/com.google/starred") updates.isStarred = 0;

  if (Object.keys(updates).length === 0) {
    logger.debug("edit-tag: no recognised tag operation", { addTag, removeTag });
    return c.text("OK");
  }

  // Stamp readAt when marking as read so the dashboard can show reads per day
  const readAt = updates.isRead === 1 ? Date.now() : undefined;
  const fullUpdates = { ...updates, ...(readAt !== undefined ? { readAt } : {}) };

  // Prefetch feedId for all items in one query — needed for the article_read metric
  const feedIdByItemId = new Map<string, string>();
  if (updates.isRead === 1) {
    const rows = await db
      .select({ id: items.id, feedId: items.feedId })
      .from(items)
      .where(inArray(items.id, itemIds));
    for (const row of rows) feedIdByItemId.set(row.id, row.feedId);
  }

  // Batch all upserts into a single D1 round-trip instead of N individual calls
  const stmts = itemIds.map((itemId) =>
    db
      .insert(itemState)
      .values({ itemId, userId, isRead: 0, isStarred: 0, ...fullUpdates })
      .onConflictDoUpdate({
        target: [itemState.itemId, itemState.userId],
        set: fullUpdates,
      })
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.batch(stmts as unknown as [any, ...any[]]);

  if (updates.isRead === 1) {
    for (const itemId of itemIds) {
      const feedId = feedIdByItemId.get(itemId) ?? "";
      metrics.recordRead({ userId, articleId: itemId, feedId });
    }
  }

  logger.info("edit-tag", { count: itemIds.length, addTag, removeTag });
  c.executionCtx.waitUntil(metrics.flush());
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
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const parsed = markAllReadSchema.safeParse(body);
  if (!parsed.success) return c.text("Error", 400);

  const { s, ts } = parsed.data;
  const streamId = parseStreamId(s);

  // ts is in microseconds; convert to ms for comparison against publishedAt
  const cutoffMs = ts ? Math.floor(ts / 1000) : null;
  const cutoffClause = cutoffMs !== null ? "AND i.published_at < ?" : "";

  // For "feed" type, resolve the canonical feed ID first (value may be URL or ID)
  let feedId: string | null = null;
  if (streamId.type === "feed") {
    const feed = await db
      .select({ id: feeds.id })
      .from(feeds)
      .where(or(eq(feeds.id, streamId.value!), eq(feeds.feedUrl, streamId.value!)))
      .get();
    if (!feed) return c.text("OK");
    feedId = feed.id;
  }

  // Raw SQL rationale: mark-all-as-read must update an unbounded number of
  // rows in a single D1 round-trip. A server-side INSERT...SELECT avoids
  // loading item IDs into Worker memory. Drizzle ORM doesn't support
  // INSERT...SELECT, so we drop to the raw D1 prepared-statement API here.
  // The LEFT JOIN filter ensures only unread items are touched.
  let insertSql: string;
  const params: (string | number)[] = [];

  if (streamId.type === "feed") {
    insertSql = `
      INSERT INTO item_state (item_id, user_id, is_read, is_starred)
      SELECT i.id, ?, 1, 0
      FROM items i
      LEFT JOIN item_state s ON s.item_id = i.id AND s.user_id = ?
      WHERE i.feed_id = ?
        AND (s.is_read IS NULL OR s.is_read = 0)
        ${cutoffClause}
      ON CONFLICT (item_id, user_id) DO UPDATE SET is_read = 1
    `;
    params.push(userId, userId, feedId!);
  } else if (streamId.type === "folder") {
    insertSql = `
      INSERT INTO item_state (item_id, user_id, is_read, is_starred)
      SELECT i.id, ?, 1, 0
      FROM items i
      LEFT JOIN item_state s ON s.item_id = i.id AND s.user_id = ?
      WHERE i.feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ? AND folder = ?)
        AND (s.is_read IS NULL OR s.is_read = 0)
        ${cutoffClause}
      ON CONFLICT (item_id, user_id) DO UPDATE SET is_read = 1
    `;
    params.push(userId, userId, userId, streamId.value!);
  } else if (streamId.type === "all") {
    insertSql = `
      INSERT INTO item_state (item_id, user_id, is_read, is_starred)
      SELECT i.id, ?, 1, 0
      FROM items i
      LEFT JOIN item_state s ON s.item_id = i.id AND s.user_id = ?
      WHERE i.feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ?)
        AND (s.is_read IS NULL OR s.is_read = 0)
        ${cutoffClause}
      ON CONFLICT (item_id, user_id) DO UPDATE SET is_read = 1
    `;
    params.push(userId, userId, userId);
  } else {
    return c.text("OK");
  }

  if (cutoffMs !== null) params.push(cutoffMs);

  const result = await c.env.DB.prepare(insertSql).bind(...params).run();
  const count = result.meta.changes ?? 0;

  logger.info("mark-all-as-read", { stream: s, count });
  return c.text("OK");
});

export { state };
