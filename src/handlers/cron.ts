import { createApiTokenLifecycle } from "../domain/tokens";
import { createLogger } from "../lib/logger";
import type { PollTriggerReason } from "../feed/poll";

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

export async function triggerFeedPollingWorkflow(
  env: Env,
  triggerReason: PollTriggerReason = "scheduled",
): Promise<void> {
  const logger = createLogger({
    cron:
      triggerReason === "forced"
        ? "triggerForcePollingWorkflow"
        : "triggerFeedPollingWorkflow",
  });
  const instance = await env.FEED_POLLING_WORKFLOW.create({
    params: { triggerReason },
  });
  logger.info("feed polling workflow started", {
    instanceId: instance.id,
    triggerReason,
  });
}

// ---------------------------------------------------------------------------
// Article cleanup — runs weekly (Mondays 03:00 UTC)
// ---------------------------------------------------------------------------

export async function purgeOldItems(env: Env): Promise<void> {
  const logger = createLogger({ cron: "purgeOldItems" });
  const retentionDays = parseInt(env.ITEM_RETENTION_DAYS ?? "30", 10);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Delete non-starred item_state first to satisfy FK constraint
  const stateResult = await env.DB.prepare(
    "DELETE FROM item_state WHERE item_id IN (SELECT id FROM items WHERE fetched_at < ?) AND is_starred = 0",
  )
    .bind(cutoffMs)
    .run();

  // Delete items that are old AND not starred by any user
  const itemResult = await env.DB.prepare(
    "DELETE FROM items WHERE fetched_at < ? AND id NOT IN (SELECT item_id FROM item_state WHERE is_starred = 1)",
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

async function purgeRevokedTokens(env: Env): Promise<void> {
  const logger = createLogger({ cron: "purgeRevokedTokens" });
  const tokenLifecycle = createApiTokenLifecycle(env.DB);
  const deleted = await tokenLifecycle.purgeRevoked();

  logger.info("purged revoked tokens", { deleted });
}
