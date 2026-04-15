import { Hono } from "hono";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../lib/db";
import { createLogger } from "../../lib/logger";
import { createMetrics } from "../../lib/metrics";
import { feeds, subscriptions } from "../../db/schema";
import type { Variables } from "./helpers";

const subs = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /reader/api/0/subscription/list
// ---------------------------------------------------------------------------

subs.get("/reader/api/0/subscription/list", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/subscription/list",
    userId: c.get("userId"),
  });
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const rows = await db
    .select({
      subId: subscriptions.id,
      title: subscriptions.title,
      folder: subscriptions.folder,
      feedId: feeds.id,
      feedUrl: feeds.feedUrl,
      htmlUrl: feeds.htmlUrl,
      feedTitle: feeds.title,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(eq(subscriptions.userId, userId));

  logger.info("subscription/list", { count: rows.length });

  return c.json({
    subscriptions: rows.map((r) => ({
      id: `feed/${r.feedId}`,
      title: r.title ?? r.feedTitle ?? r.feedUrl,
      htmlUrl: r.htmlUrl ?? "",
      url: r.feedUrl,
      categories: r.folder
        ? [{ id: `user/-/label/${r.folder}`, label: r.folder }]
        : [],
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /reader/api/0/tag/list
// ---------------------------------------------------------------------------
// Returns system tags (starred) plus all user-defined folder labels.
// Clients use this to populate their folder/tag sidebar.

subs.get("/reader/api/0/tag/list", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/tag/list",
    userId: c.get("userId"),
  });
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const folderRows = await db
    .selectDistinct({ folder: subscriptions.folder })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.userId, userId), isNotNull(subscriptions.folder)),
    );

  logger.info("tag/list", { folders: folderRows.length });

  const tags = [
    { id: "user/-/state/com.google/starred" },
    ...folderRows.map((r) => ({ id: `user/-/label/${r.folder}` })),
  ];

  return c.json({ tags });
});

// ---------------------------------------------------------------------------
// POST /reader/api/0/subscription/quickadd
// ---------------------------------------------------------------------------
// Adds a subscription by feed URL directly, without the full edit flow.

subs.post("/reader/api/0/subscription/quickadd", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/subscription/quickadd",
    userId: c.get("userId"),
  });
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const feedUrl =
    typeof body["quickadd"] === "string" ? body["quickadd"].trim() : null;

  if (!feedUrl) {
    logger.warn("quickadd missing feedUrl");
    return c.text("Error", 400);
  }

  await db
    .insert(feeds)
    .values({ id: crypto.randomUUID(), feedUrl })
    .onConflictDoNothing();
  const feed = await db
    .select()
    .from(feeds)
    .where(eq(feeds.feedUrl, feedUrl))
    .get();
  if (!feed) return c.text("Error", 500);

  await db
    .insert(subscriptions)
    .values({
      id: crypto.randomUUID(),
      userId,
      feedId: feed.id,
      title: null,
      folder: null,
    })
    .onConflictDoNothing();

  logger.info("quickadd subscribed", { feedUrl, feedId: feed.id });

  return c.json({ numResults: 1, query: feedUrl, streamId: `feed/${feed.id}` });
});

// ---------------------------------------------------------------------------
// POST /reader/api/0/subscription/edit
// ---------------------------------------------------------------------------

const subscriptionEditSchema = z.object({
  ac: z.enum(["subscribe", "unsubscribe", "edit"]),
  s: z.string().min(1), // feed/<feed-url> or feed/<feed-id>
  t: z.string().optional(), // custom title
  a: z.string().optional(), // add label: user/-/label/<folder>
  r: z.string().optional(), // remove label
});

subs.post("/reader/api/0/subscription/edit", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/subscription/edit",
    userId: c.get("userId"),
  });
  const metrics = createMetrics(c.env.METRICS_PIPELINE, c.executionCtx);
  const db = getDb(c.env.DB);
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const parsed = subscriptionEditSchema.safeParse(body);

  if (!parsed.success) {
    logger.warn("subscription/edit bad request", {
      errors: parsed.error.issues,
    });
    return c.text("Error", 400);
  }

  const { ac, s, t, a, r } = parsed.data;

  // s is always "feed/<url-or-id>"
  const feedRef = s.startsWith("feed/") ? s.slice(5) : s;

  if (ac === "subscribe") {
    const feedUrl = feedRef;

    // Upsert feed row (cron will populate title/content later)
    let feed = await db
      .select()
      .from(feeds)
      .where(eq(feeds.feedUrl, feedUrl))
      .get();
    if (!feed) {
      await db
        .insert(feeds)
        .values({ id: crypto.randomUUID(), feedUrl })
        .onConflictDoNothing();
      feed = await db
        .select()
        .from(feeds)
        .where(eq(feeds.feedUrl, feedUrl))
        .get();
    }
    if (!feed) return c.text("Error", 500);

    const folder = a?.startsWith("user/-/label/")
      ? a.slice("user/-/label/".length)
      : null;

    await db
      .insert(subscriptions)
      .values({
        id: crypto.randomUUID(),
        userId,
        feedId: feed.id,
        title: t ?? null,
        folder,
      })
      .onConflictDoNothing();

    logger.info("subscribed", { feedUrl, folder });
    metrics.recordSubscription({
      userId,
      feedId: feed.id,
      action: "subscribe",
      folder: folder ?? undefined,
    });
  }

  if (ac === "unsubscribe") {
    // feedRef may be feed ID or URL — try both
    const feed = await db
      .select({ id: feeds.id })
      .from(feeds)
      .where(or(eq(feeds.id, feedRef), eq(feeds.feedUrl, feedRef)))
      .get();

    if (feed) {
      await db
        .delete(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, feed.id),
          ),
        );
    }

    logger.info("unsubscribed", { feedRef });
    if (feed) {
      metrics.recordSubscription({
        userId,
        feedId: feed.id,
        action: "unsubscribe",
      });
    }
  }

  if (ac === "edit") {
    const feed =
      (await db
        .select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.id, feedRef))
        .get()) ??
      (await db
        .select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, feedRef))
        .get());

    if (!feed) return c.text("Error", 404);

    const updates: Partial<typeof subscriptions.$inferInsert> = {};
    if (t !== undefined) updates.title = t;
    // Apply label changes: `a` adds a folder, `r` removes one.
    // `a` takes precedence if both arrive in the same request.
    if (r?.startsWith("user/-/label/")) updates.folder = null;
    if (a?.startsWith("user/-/label/"))
      updates.folder = a.slice("user/-/label/".length);

    if (Object.keys(updates).length > 0) {
      await db
        .update(subscriptions)
        .set(updates)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, feed.id),
          ),
        );
    }

    logger.info("subscription edited", { feedRef, updates });
    metrics.recordSubscription({
      userId,
      feedId: feed.id,
      action: "edit",
      folder: typeof updates.folder === "string" ? updates.folder : undefined,
    });
  }

  return c.text("OK");
});

export { subs };
