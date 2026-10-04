import { Hono } from "hono";
import * as v from "valibot";
import { createLogger } from "../lib/logger";
import { createActivity } from "../feed/activity";
import { selectDueFeeds } from "../feed/eligibility";
import {
  ATTEMPT_RETENTION_DAYS,
  PROBLEM_WINDOW_DAYS,
  createFeedHistory,
  decodeCursor,
  encodeCursor,
} from "../feed/history";
import { createSubscriptionLifecycle } from "../feed/subscriptions";
import { parseOpml } from "../lib/opml";
import { triggerFeedPollingWorkflow } from "./cron";
import { getDb } from "../lib/db";
import { eq } from "drizzle-orm";
import { feeds } from "../db/schema";
import type {
  AttemptStatus,
  FeedAttempt,
  FeedAttemptsResponse,
  FeedDetailResponse,
  FeedsResponse,
  ImportResponse,
  OverviewPanelsResponse,
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
    const activity = createActivity(c.env.DB);
    const summary = await activity.overviewSummary(userId, Date.now());
    const timezone =
      (c.env as unknown as Record<string, string>).DISPLAY_TIMEZONE || "UTC";

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
// GET /app/api/overview/panels — reading trend, feed health buckets, cycle
// lifecycle, needs-attention list, and the optional Analytics Engine panel
// (which degrades independently and never blocks the core projections).
// ---------------------------------------------------------------------------

handler.get("/app/api/overview/panels", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/overview/panels", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  const timezone =
    (c.env as unknown as Record<string, string>).DISPLAY_TIMEZONE || "UTC";

  const activity = createActivity(c.env.DB);
  let panels: Awaited<ReturnType<typeof activity.overviewPanels>>;
  try {
    panels = await activity.overviewPanels(userId, Date.now(), timezone);
  } catch (err) {
    logger.error(
      "overview panels failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to load overview panels" }, 500);
  }

  // Optional AE projection — isolated so an AE outage or missing
  // credentials degrades this panel alone.
  let analyticsEngine: OverviewPanelsResponse["analyticsEngine"] = {
    status: "unavailable",
  };
  try {
    const envVars = c.env as unknown as Record<string, string>;
    const cfApiToken = envVars.CF_API_TOKEN;
    const aeEnabled = envVars.ANALYTICS_ENABLED !== "false" && !!cfApiToken;
    if (aeEnabled) {
      const { createAnalyticsReader } = await import("../feed/analytics");
      const reader = createAnalyticsReader({
        accountId: envVars.CF_ACCOUNT_ID,
        apiToken: cfApiToken,
        enabled: true,
      });
      // trend30d needs no feed-title map — pass an empty list. The
      // adapter swallows AE failures into empty results, so an empty
      // trend reads as unavailable rather than a real zero.
      const data = await reader.queryAll([]);
      if (data.trend30d.length > 0) {
        analyticsEngine = { status: "ok", trend30d: data.trend30d };
      }
    }
  } catch (err) {
    logger.warn("analytics engine panel degraded", {
      error: err instanceof Error ? err.message : String(err),
    });
    analyticsEngine = { status: "unavailable" };
  }

  const response: OverviewPanelsResponse = {
    ...panels,
    analyticsEngine,
    generatedAt: Date.now(),
  };
  return c.json(response);
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
    const activity = createActivity(c.env.DB);
    const feeds = await activity.listFeedRows(userId);
    const folders = [
      ...new Set(feeds.map((f) => f.folder).filter((f): f is string => !!f)),
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
// GET /app/api/feeds/:feedId/attempts — bounded, cursor-paginated evidence
// history for one subscribed feed.
// ---------------------------------------------------------------------------

const ATTEMPTS_PAGE_LIMIT = 25;
const ATTEMPTS_PAGE_MAX = 50;

handler.get("/app/api/feeds/:feedId/attempts", async (c) => {
  const userId = c.get("userId");
  const { feedId } = c.req.param();
  const logger = createLogger({
    path: "/app/api/feeds/:feedId/attempts",
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

  const rawLimit = Number(c.req.query("limit") ?? ATTEMPTS_PAGE_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), ATTEMPTS_PAGE_MAX)
      : ATTEMPTS_PAGE_LIMIT;

  const rawCursor = c.req.query("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return c.json({ error: "invalid cursor" }, 400);
  }

  const history = createFeedHistory(c.env.DB);
  const [{ rows, nextCursor }, streaks, groups, total] = await Promise.all([
    history.listAttempts(feedId, cursor, limit),
    history.streaks(feedId),
    history.problemGroups(feedId, Date.now()),
    history.countAttempts(feedId),
  ]);

  const itemMap = await history.attemptItems(rows.map((r) => r.id));
  const attempts: FeedAttempt[] = rows.map((r) => ({
    id: r.id,
    cycleRunId: r.cycleRunId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    status: (r.status ?? "in_progress") as AttemptStatus,
    httpStatus: r.httpStatus,
    errorKind: r.errorKind,
    errorMessage: r.errorMessage,
    parserState: r.parserState,
    itemsAdded: r.itemsAdded,
    items: itemMap.get(r.id) ?? [],
  }));

  logger.info("feed attempts served", {
    feedId,
    returned: attempts.length,
    total,
  });

  const response: FeedAttemptsResponse = {
    attempts,
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    streaks,
    problemGroups: { windowDays: PROBLEM_WINDOW_DAYS, groups },
    historyState:
      total > 0 ? "ok" : row.lastCheckedAt != null ? "legacy" : "empty",
    retentionDays: ATTEMPT_RETENTION_DAYS,
    generatedAt: Date.now(),
  };
  return c.json(response);
});

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

  const eligible = (await selectDueFeeds(c.env.DB, Date.now(), force)).length;

  try {
    const instanceId = await triggerFeedPollingWorkflow(c.env, { force });
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
