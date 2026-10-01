import { Hono } from "hono";
import { createLogger } from "../lib/logger";
import {
  createSubscriptionLifecycle,
  type SubObserver,
} from "../feed/subscriptions";
import { createFeedHealth } from "../feed/poll";
import { triggerFeedPollingWorkflow } from "./cron";
import { App } from "../views/app";
import { FeedRow, FeedTab } from "../views/feeds";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /app/feeds — Feed tab (subscription list + OPML import form)
// ---------------------------------------------------------------------------

handler.get("/app/feeds", async (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  const logger = createLogger({ path: "/app/feeds", userId });

  const noop: SubObserver = { publish: () => {} };
  const lifecycle = createSubscriptionLifecycle(c.env.DB, noop);
  const subs = await lifecycle.list(userId);

  logger.info("feed tab loaded", { subCount: subs.length });

  return c.html(
    <App email={email} active="feed">
      <FeedTab subs={subs} />
    </App>,
  );
});

// ---------------------------------------------------------------------------
// POST /feeds/sync — trigger a normal sync (due feeds only)
// ---------------------------------------------------------------------------

handler.post("/feeds/sync", async (c) => {
  const logger = createLogger({
    path: "/feeds/sync",
    userId: c.get("userId"),
  });
  logger.info("manual sync triggered");
  c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env, "manual"));
  return c.html(
    <p class="text-sm text-muted-foreground">
      Sync started — refresh the page in a moment to see updated fetch times.
    </p>,
  );
});

// ---------------------------------------------------------------------------
// POST /feeds/sync/force — trigger a force sync (all active feeds)
// ---------------------------------------------------------------------------

handler.post("/feeds/sync/force", async (c) => {
  const logger = createLogger({
    path: "/feeds/sync/force",
    userId: c.get("userId"),
  });
  logger.info("force sync triggered");
  c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env, "forced"));
  return c.html(
    <p class="text-sm text-muted-foreground">
      Force sync started — refresh the page in a moment to see updated fetch
      times.
    </p>,
  );
});

// ---------------------------------------------------------------------------
// POST /feeds/:id/reactivate — manually reactivate a deactivated feed
// ---------------------------------------------------------------------------

handler.post("/feeds/:id/reactivate", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const logger = createLogger({ path: `/feeds/${id}/reactivate`, userId });

  const changed = await createFeedHealth(c.env.DB, () => Date.now()).reactivate(
    userId,
    id,
  );
  if (!changed) return c.text("Not found", 404);

  logger.info("feed reactivated", { feedId: id });

  const noop: SubObserver = { publish: () => {} };
  const lifecycle = createSubscriptionLifecycle(c.env.DB, noop);
  const updated = await lifecycle.get(userId, id);
  if (!updated) return c.text("Not found", 404);

  return c.html(<FeedRow sub={updated} />);
});

// ---------------------------------------------------------------------------
// POST /feeds/:id/deactivate — manually deactivate an active feed
// ---------------------------------------------------------------------------

handler.post("/feeds/:id/deactivate", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const logger = createLogger({ path: `/feeds/${id}/deactivate`, userId });

  const changed = await createFeedHealth(c.env.DB, () => Date.now()).deactivate(
    userId,
    id,
  );
  if (!changed) return c.text("Not found", 404);

  logger.info("feed deactivated", { feedId: id });

  const noop: SubObserver = { publish: () => {} };
  const lifecycle = createSubscriptionLifecycle(c.env.DB, noop);
  const updated = await lifecycle.get(userId, id);
  if (!updated) return c.text("Not found", 404);

  return c.html(<FeedRow sub={updated} />);
});

export { handler as feedsUiHandler };
