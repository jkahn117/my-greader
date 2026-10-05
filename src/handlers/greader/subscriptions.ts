import { Hono } from "hono";
import * as v from "valibot";
import { createLogger } from "../../lib/logger";
import { createMetrics } from "../../lib/metrics";
import {
  createSubscriptionLifecycle,
  type SubObserver,
} from "../../feed/subscriptions";
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
  const userId = c.get("userId");

  const noop: SubObserver = { publish: () => {} };
  const lifecycle = createSubscriptionLifecycle(c.env.DB, noop);
  const rows = await lifecycle.list(userId);

  logger.info("subscription/list", { count: rows.length });

  return c.json({
    subscriptions: rows.map((r) => ({
      id: `feed/${r.feedId}`,
      title: r.title ?? r.feedUrl,
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

subs.get("/reader/api/0/tag/list", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/tag/list",
    userId: c.get("userId"),
  });
  const lifecycle = createSubscriptionLifecycle(c.env.DB, {
    publish: () => {},
  });
  const folders = new Set(
    (await lifecycle.list(c.get("userId")))
      .map((subscription) => subscription.folder)
      .filter((folder): folder is string => folder != null),
  );

  logger.info("tag/list", { folders: folders.size });

  const tags = [
    { id: "user/-/state/com.google/starred" },
    ...[...folders].map((folder) => ({ id: `user/-/label/${folder}` })),
  ];

  return c.json({ tags });
});

// ---------------------------------------------------------------------------
// POST /reader/api/0/subscription/quickadd
// ---------------------------------------------------------------------------

subs.post("/reader/api/0/subscription/quickadd", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/subscription/quickadd",
    userId: c.get("userId"),
  });
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const feedUrl =
    typeof body["quickadd"] === "string" ? body["quickadd"].trim() : null;

  if (!feedUrl) {
    logger.warn("quickadd missing feedUrl");
    return c.text("Error", 400);
  }

  const noop: SubObserver = { publish: () => {} };
  const lifecycle = createSubscriptionLifecycle(c.env.DB, noop);

  try {
    const result = await lifecycle.subscribe(userId, feedUrl);
    logger.info("quickadd subscribed", {
      feedUrl,
      feedId: result.feedId,
    });
    return c.json({
      numResults: 1,
      query: feedUrl,
      streamId: `feed/${result.feedId}`,
    });
  } catch {
    return c.text("Error", 500);
  }
});

// ---------------------------------------------------------------------------
// POST /reader/api/0/subscription/edit
// ---------------------------------------------------------------------------

const subscriptionEditSchema = v.object({
  ac: v.picklist(["subscribe", "unsubscribe", "edit"]),
  s: v.pipe(v.string(), v.minLength(1)),
  t: v.optional(v.string()),
  a: v.optional(v.string()),
  r: v.optional(v.string()),
});

subs.post("/reader/api/0/subscription/edit", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/subscription/edit",
    userId: c.get("userId"),
  });
  const metrics = createMetrics(
    c.env.ANALYTICS,
    (c.env.ANALYTICS_ENABLED as string) !== "false",
  );
  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const parsed = v.safeParse(subscriptionEditSchema, body);

  if (!parsed.success) {
    logger.warn("subscription/edit bad request", {
      errors: parsed.issues,
    });
    return c.text("Error", 400);
  }

  const { ac, s, t, a, r } = parsed.output;

  const feedRef = s.startsWith("feed/") ? s.slice(5) : s;

  const observer: SubObserver = {
    publish(event) {
      switch (event.kind) {
        case "subscribed":
          logger.info("subscribed", {
            feedUrl: event.feedUrl,
            folder: event.folder,
          });
          metrics.recordSubscription({
            userId: event.userId,
            feedId: event.feedId,
            action: "subscribe",
            folder: event.folder,
          });
          break;
        case "unsubscribed":
          logger.info("unsubscribed", { feedId: event.feedId });
          metrics.recordSubscription({
            userId: event.userId,
            feedId: event.feedId,
            action: "unsubscribe",
          });
          break;
        case "subscriptionEdited":
          logger.info("subscription edited", {
            feedId: event.feedId,
            folder: event.folder,
          });
          metrics.recordSubscription({
            userId: event.userId,
            feedId: event.feedId,
            action: "edit",
            folder: event.folder ?? undefined,
          });
          break;
      }
    },
  };

  const lifecycle = createSubscriptionLifecycle(c.env.DB, observer);

  if (ac === "subscribe") {
    const folder = a?.startsWith("user/-/label/")
      ? a.slice("user/-/label/".length)
      : null;
    try {
      await lifecycle.subscribe(userId, feedRef, {
        title: t,
        folder: folder ?? undefined,
      });
    } catch {
      return c.text("Error", 500);
    }
  }

  if (ac === "unsubscribe") {
    await lifecycle.unsubscribe(userId, feedRef);
  }

  if (ac === "edit") {
    let folder: string | null | undefined = undefined;
    if (r?.startsWith("user/-/label/")) folder = null;
    if (a?.startsWith("user/-/label/"))
      folder = a.slice("user/-/label/".length);
    const result = await lifecycle.edit(userId, feedRef, {
      title: t,
      folder,
    });
    if (!result) return c.text("Error", 404);
  }

  c.executionCtx.waitUntil(metrics.flush());
  return c.text("OK");
});

export { subs };
