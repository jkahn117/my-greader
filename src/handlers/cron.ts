import { createApiTokenLifecycle } from "../domain/tokens";
import { createLogger } from "../lib/logger";
import type { PollTriggerReason } from "../feed/poll";
import { createRetentionManager } from "../feed/retention";

// ---------------------------------------------------------------------------
// Entry point — dispatches on cron schedule string
// ---------------------------------------------------------------------------

export type CronEnv = Pick<Env, "DB" | "FEED_POLLING_WORKFLOW"> & {
  ITEM_RETENTION_DAYS: string;
};

export async function scheduled(
  event: Pick<ScheduledEvent, "cron">,
  env: CronEnv,
): Promise<void> {
  switch (event.cron) {
    case "*/30 * * * *":
      await triggerFeedPollingWorkflow(env);

      return;
    case "0 3 * * 1":
      await purgeRevokedTokens(env);

      return purgeRetention(env);
    default:
      createLogger().warn("unknown cron schedule", { cron: event.cron });
  }
}

// ---------------------------------------------------------------------------
// Trigger the FeedPollingWorkflow
// ---------------------------------------------------------------------------

export async function triggerFeedPollingWorkflow(
  env: Pick<CronEnv, "FEED_POLLING_WORKFLOW">,
  triggerReason: PollTriggerReason = "scheduled",
): Promise<string> {
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

  return instance.id;
}

// ---------------------------------------------------------------------------
// Item and operational-history cleanup — runs weekly (Mondays 03:00 UTC)
// ---------------------------------------------------------------------------

async function purgeRetention(
  env: Pick<CronEnv, "DB" | "ITEM_RETENTION_DAYS">,
): Promise<void> {
  const logger = createLogger({ cron: "purgeRetention" });
  const itemRetentionDays = parseInt(env.ITEM_RETENTION_DAYS ?? "30", 10);
  const retention = createRetentionManager(env.DB);
  const result = await retention.purge(itemRetentionDays);

  logger.info("purged retained data", { itemRetentionDays, ...result });

  if (result.itemsBacklogRemaining || result.cycleRunsBacklogRemaining) {
    logger.warn("retention backlog remains", { itemRetentionDays, ...result });
  }
}

// ---------------------------------------------------------------------------
// Revoked token cleanup — runs as part of the weekly cron
// ---------------------------------------------------------------------------

async function purgeRevokedTokens(env: Pick<CronEnv, "DB">): Promise<void> {
  const logger = createLogger({ cron: "purgeRevokedTokens" });
  const tokenLifecycle = createApiTokenLifecycle(env.DB);
  const deleted = await tokenLifecycle.purgeRevoked();

  logger.info("purged revoked tokens", { deleted });
}
