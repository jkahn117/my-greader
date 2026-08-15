import { lte } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { apiTokens } from "../db/schema";

export type { FeedPollResult as FeedResult } from "../feed/poll";

// ---------------------------------------------------------------------------
// Entry point — dispatches on cron schedule string
// ---------------------------------------------------------------------------

export async function scheduled(
  event: ScheduledEvent,
  env: Env,
): Promise<void> {
  switch (event.cron) {
    case "*/30 * * * *":
      return triggerFeedPollingWorkflow(env);
    case "0 3 * * 1":
      await purgeRevokedTokens(env);
      return purgeOldItems(env);
    default:
      createLogger().warn("unknown cron schedule", { cron: event.cron });
  }
}

// ---------------------------------------------------------------------------
// Trigger the FeedPollingWorkflow — replaces the old inline fetchFeeds loop
// ---------------------------------------------------------------------------

export async function triggerFeedPollingWorkflow(env: Env): Promise<void> {
  const logger = createLogger({ cron: "triggerFeedPollingWorkflow" });
  const instance = await env.FEED_POLLING_WORKFLOW.create();
  logger.info("feed polling workflow started", { instanceId: instance.id });
}

// ---------------------------------------------------------------------------
// Article cleanup — runs weekly (Mondays 03:00 UTC)
// ---------------------------------------------------------------------------

export async function purgeOldItems(env: Env): Promise<void> {
  const logger = createLogger({ cron: "purgeOldItems" });
  const retentionDays = parseInt(env.ITEM_RETENTION_DAYS ?? "30", 10);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Delete item_state first to satisfy FK constraint, then items
  const stateResult = await env.DB.prepare(
    "DELETE FROM item_state WHERE item_id IN (SELECT id FROM items WHERE fetched_at < ?)",
  )
    .bind(cutoffMs)
    .run();

  const itemResult = await env.DB.prepare(
    "DELETE FROM items WHERE fetched_at < ?",
  )
    .bind(cutoffMs)
    .run();

  logger.info("purged old items", {
    retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    statesDeleted: stateResult.meta.changes,
    itemsDeleted: itemResult.meta.changes,
  });
}

// ---------------------------------------------------------------------------
// Revoked token cleanup — runs as part of the weekly cron
// ---------------------------------------------------------------------------

const TOKEN_RETENTION_DAYS = 7; // keep revoked tokens for 7 days before deleting

async function purgeRevokedTokens(env: Env): Promise<void> {
  const logger = createLogger({ cron: "purgeRevokedTokens" });
  const db = getDb(env.DB);
  const cutoffMs = Date.now() - TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const result = await db
    .delete(apiTokens)
    .where(lte(apiTokens.revokedAt, cutoffMs));

  logger.info("purged revoked tokens", {
    cutoff: new Date(cutoffMs).toISOString(),
    deleted: result.meta.changes,
  });
}
