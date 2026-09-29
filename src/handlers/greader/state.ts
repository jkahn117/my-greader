import { Hono } from "hono";
import * as v from "valibot";
import { createLogger } from "../../lib/logger";
import { createMetrics } from "../../lib/metrics";
import { normalizeItemId } from "../../lib/crypto";
import { createItemStateModule } from "../../feed/item-state";
import { parseStreamId } from "./helpers";
import type { Variables } from "./helpers";

const state = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /reader/api/0/edit-tag
// ---------------------------------------------------------------------------
// Marks individual items as read/unread or starred/unstarred.

const editTagSchema = v.object({
  // `i` may appear multiple times — parsed with { all: true }
  a: v.optional(v.string()), // add tag
  r: v.optional(v.string()), // remove tag
});

state.post("/reader/api/0/edit-tag", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/edit-tag",
    userId: c.get("userId"),
  });
  const metrics = createMetrics(
    c.env.ANALYTICS,
    (c.env.ANALYTICS_ENABLED as string) !== "false",
  );
  const userId = c.get("userId");

  const body = await c.req.parseBody({ all: true });
  const parsed = v.safeParse(editTagSchema, body);
  if (!parsed.success) return c.text("Error", 400);

  const { a, r } = parsed.output;

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
    logger.debug("edit-tag: no recognised tag operation", {
      addTag,
      removeTag,
    });
    return c.text("OK");
  }

  const changedItems = await createItemStateModule(c.env.DB).update({
    userId,
    itemIds,
    changes: {
      ...(updates.isRead !== undefined ? { isRead: updates.isRead === 1 } : {}),
      ...(updates.isStarred !== undefined
        ? { isStarred: updates.isStarred === 1 }
        : {}),
    },
  });

  if (updates.isRead === 1) {
    for (const item of changedItems) {
      metrics.recordRead({
        userId,
        articleId: item.itemId,
        feedId: item.feedId,
      });
    }
  }

  logger.info("edit-tag", {
    requestedCount: itemIds.length,
    changedCount: changedItems.length,
    addTag,
    removeTag,
  });
  c.executionCtx.waitUntil(metrics.flush());
  return c.text("OK");
});

// ---------------------------------------------------------------------------
// POST /reader/api/0/mark-all-as-read
// ---------------------------------------------------------------------------

const markAllReadSchema = v.object({
  s: v.pipe(v.string(), v.minLength(1)),
  ts: v.optional(v.pipe(v.string(), v.transform(Number), v.number())),
});

state.post("/reader/api/0/mark-all-as-read", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/mark-all-as-read",
    userId: c.get("userId"),
  });
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const parsed = v.safeParse(markAllReadSchema, body);
  if (!parsed.success) return c.text("Error", 400);

  const { s, ts } = parsed.output;
  const streamId = parseStreamId(s);

  // GReader timestamps use microseconds while Item timestamps use milliseconds.
  const cutoffMs = ts ? Math.floor(ts / 1000) : null;
  const count = await createItemStateModule(c.env.DB).markAllRead({
    userId,
    scope: streamId,
    before: cutoffMs,
  });

  logger.info("mark-all-as-read", { stream: s, count });
  return c.text("OK");
});

export { state };
