import { Hono } from "hono";
import * as v from "valibot";
import { createLogger } from "../lib/logger";
import { createActivityReader } from "../feed/activity";
import { countEligibleFeeds } from "../feed/poll";
import { createSubscriptionLifecycle } from "../feed/subscriptions";
import { parseOpml } from "../lib/opml";
import { triggerFeedPollingWorkflow } from "./cron";
import { getDb } from "../lib/db";
import { eq } from "drizzle-orm";
import { feeds } from "../db/schema";
import type {
  FeedDetailResponse,
  FeedsResponse,
  ImportResponse,
  OverviewResponse,
  SyncResponse,
} from "../shared/dashboard-api";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /app/api/overview — Overview summary totals for the authenticated user
// ---------------------------------------------------------------------------

handler.get("/app/api/overview", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/overview", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  try {
    const activity = createActivityReader(c.env.DB);
    const summary = await activity.overviewSummary(userId);
    const timezone = c.env.DISPLAY_TIMEZONE || "UTC";

    const response: OverviewResponse = {
      ...summary,
      timezone,
      generatedAt: Date.now(),
    };
    logger.info("overview summary served", { feedCount: summary.feedCount });
    return c.json(response);
  } catch (err) {
    logger.error(
      "overview summary failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to load overview" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /app/api/feeds — subscription workspace rows for the authenticated user
// ---------------------------------------------------------------------------

handler.get("/app/api/feeds", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/feeds", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  try {
    const lifecycle = createSubscriptionLifecycle(c.env.DB, {
      publish: () => {},
    });
    const subscriptions = await lifecycle.list(userId);
    const feeds = subscriptions.map((subscription) => ({
      feedId: subscription.feedId,
      subscriptionId: subscription.id,
      title: subscription.title,
      feedUrl: subscription.feedUrl,
      htmlUrl: subscription.htmlUrl,
      folder: subscription.folder,
      status:
        subscription.deactivatedAt !== null
          ? ("deactivated" as const)
          : subscription.lastSuccessfulPollAt === null
            ? ("new" as const)
            : subscription.consecutiveErrors > 0
              ? ("failing" as const)
              : ("active" as const),
      lastSuccessfulAt: subscription.lastSuccessfulPollAt,
      lastCheckedAt: subscription.lastSuccessfulPollAt,
      nextCheckAt: subscription.nextPollAt,
      lastNewItemAt: subscription.lastNewItemDiscoveredAt,
      consecutiveErrors: subscription.consecutiveErrors,
      lastError: subscription.lastError,
      checkIntervalMinutes: subscription.checkIntervalMinutes,
      deactivatedAt: subscription.deactivatedAt,
      deactivatedReason: subscription.deactivationReason,
      legacyUncertain: subscription.pollStateOrigin === "legacy_uncertain",
    }));
    const folders = [
      ...new Set(feeds.map((feed) => feed.folder).filter((folder): folder is string => !!folder)),
    ].sort();

    const response: FeedsResponse = {
      feeds,
      folders,
      generatedAt: Date.now(),
    };
    logger.info("feeds list served", { feedCount: feeds.length });
    return c.json(response);
  } catch (err) {
    logger.error(
      "feeds list failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to load feeds" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /app/api/feeds/:feedId — current-state detail for one subscription
// ---------------------------------------------------------------------------

handler.get("/app/api/feeds/:feedId", async (c) => {
  const userId = c.get("userId");
  const { feedId } = c.req.param();
  const logger = createLogger({ path: "/app/api/feeds/:feedId", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  const activity = createActivity(c.env.DB);
  const row = await activity.getFeedRow(userId, feedId);
  if (!row) {
    logger.info("feed detail rejected — not subscribed", { feedId });
    return c.json({ error: "feed not found" }, 404);
  }

  const response: FeedDetailResponse = {
    ...row,
    backloadComplete: row.lastSuccessfulAt != null,
  };
  return c.json(response);
});

// ---------------------------------------------------------------------------
// POST /app/api/feeds/:feedId/deactivate|reactivate — manual state change
// under the existing polling policy (deactivated feeds are never selected).
// ---------------------------------------------------------------------------

for (const action of ["deactivate", "reactivate"] as const) {
  handler.post(`/app/api/feeds/:feedId/${action}`, async (c) => {
    const userId = c.get("userId");
    const { feedId } = c.req.param();
    const logger = createLogger({
      path: `/app/api/feeds/:feedId/${action}`,
      userId,
    });

    if (!c.env.DB) {
      return c.json({ error: "database unavailable" }, 503);
    }

    const activity = createActivity(c.env.DB);
    const row = await activity.getFeedRow(userId, feedId);
    if (!row) {
      return c.json({ error: "feed not found" }, 404);
    }

    const db = getDb(c.env.DB);
    try {
      if (action === "deactivate") {
        if (row.deactivatedAt == null) {
          await db
            .update(feeds)
            .set({ deactivatedAt: Date.now(), deactivatedReason: "manual" })
            .where(eq(feeds.id, feedId));
        }
      } else if (row.deactivatedAt != null) {
        await db
          .update(feeds)
          .set({
            deactivatedAt: null,
            deactivatedReason: null,
            consecutiveErrors: 0,
            lastError: null,
            checkIntervalMinutes: 30,
          })
          .where(eq(feeds.id, feedId));
      }
    } catch (err) {
      logger.error(
        `feed ${action} failed`,
        err instanceof Error ? err : { err: String(err) },
      );
      return c.json({ error: `failed to ${action} feed` }, 500);
    }

    logger.info(`feed ${action}d`, { feedId });
    const updated = await activity.getFeedRow(userId, feedId);
    const response: FeedDetailResponse = {
      ...updated!,
      backloadComplete: updated!.lastSuccessfulAt != null,
    };
    return c.json(response);
  });
}

// ---------------------------------------------------------------------------
// POST /app/api/import — OPML upload; reports imported/duplicates/failed URLs
// ---------------------------------------------------------------------------

handler.post("/app/api/import", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/import", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  const body = await c.req.parseBody();
  const file = body["opml"];
  if (!file || typeof file === "string") {
    return c.json({ error: "an OPML file is required" }, 400);
  }

  const parsedList = parseOpml(await file.text());
  if (parsedList.length === 0) {
    return c.json({ error: "no feeds found in the uploaded file" }, 400);
  }

  const lifecycle = createSubscriptionLifecycle(c.env.DB, {
    publish: () => {},
  });

  let imported = 0;
  let duplicates = 0;
  const errors: string[] = [];

  for (const parsed of parsedList) {
    try {
      const result = await lifecycle.subscribe(userId, parsed.feedUrl, {
        title: parsed.title ?? undefined,
        folder: parsed.folder ?? undefined,
        feedTitle: parsed.title ?? undefined,
        feedHtmlUrl: parsed.htmlUrl ?? undefined,
      });
      if (result.created) imported++;
      else duplicates++;
    } catch (err) {
      logger.error("error importing feed", {
        feedUrl: parsed.feedUrl,
        err: String(err),
      });
      errors.push(parsed.feedUrl);
    }
  }

  logger.info("OPML import complete", {
    imported,
    duplicates,
    errors: errors.length,
  });

  // Kick a poll so newly added feeds populate promptly
  if (imported > 0) {
    c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env));
  }

  const response: ImportResponse = { imported, duplicates, errors };
  return c.json(response);
});

// ---------------------------------------------------------------------------
// POST /app/api/feeds/sync — manual poll trigger; {force:true} bypasses due
// time only (deactivated and unsubscribed feeds stay excluded).
// ---------------------------------------------------------------------------

const SyncBody = v.object({ force: v.optional(v.boolean()) });

handler.post("/app/api/feeds/sync", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/feeds/sync", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  let parsedBody: v.InferOutput<typeof SyncBody> = {};
  const raw = await c.req.text();
  if (raw.length > 0) {
    try {
      parsedBody = v.parse(SyncBody, JSON.parse(raw));
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
  }
  const force = parsedBody.force === true;

  const eligible = await countEligibleFeeds(c.env.DB, Date.now(), force);

  try {
    const instanceId = await triggerFeedPollingWorkflow(
      c.env,
      force ? "forced" : "manual",
    );
    logger.info("manual sync triggered", { force, eligible });

    const response: SyncResponse = {
      triggered: true,
      eligible,
      forced: force,
      instanceId,
    };
    return c.json(response);
  } catch (err) {
    logger.error(
      "manual sync failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to start sync" }, 503);
  }
});

export { handler as dashboardHandler };
