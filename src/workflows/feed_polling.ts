import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { createMetrics } from "../lib/metrics";
import { feeds, subscriptions } from "../db/schema";
import { fetchAndStoreFeed, FeedResult } from "../handlers/cron";

// No per-run parameters needed — the Workflow always fetches all due feeds
type Params = Record<string, never>;

// Each feed fetch costs 2 subrequests (1 HTTP + 1 D1 write).
// Sequential steps each get their own fresh subrequest budget (free plan: 50).
// Concurrent fan-out within a step shares the budget, so batch size = floor(50 / 2) - safety margin.
const FEEDS_PER_STEP = 20;

// ---------------------------------------------------------------------------
// FeedPollingWorkflow
//
// Triggered every 30 minutes by the cron handler.
//
// Sequential step design: concurrent fan-out inside a single step shares that
// step's subrequest budget. Sequential steps each run in a new Worker
// invocation with a fresh budget. We therefore batch feeds into groups of
// FEEDS_PER_STEP — feeds within a batch are fetched concurrently, batches are
// processed one at a time.
// ---------------------------------------------------------------------------

export class FeedPollingWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    const logger = createLogger({ workflow: "FeedPollingWorkflow", instanceId: event.instanceId });

    // ------------------------------------------------------------------
    // Step 1 — query feeds that are due for a check
    // ------------------------------------------------------------------

    const { dueFeeds, totalActiveFeeds } = await step.do("get-due-feeds", async () => {
      const db = getDb(this.env.DB);
      const now = Date.now();

      const [due, activeCount] = await db.batch([
        db
          .selectDistinct({
            id: feeds.id,
            feedUrl: feeds.feedUrl,
            title: feeds.title,
            htmlUrl: feeds.htmlUrl,
            etag: feeds.etag,
            lastModified: feeds.lastModified,
            lastFetchedAt: feeds.lastFetchedAt,
            consecutiveErrors: feeds.consecutiveErrors,
            checkIntervalMinutes: feeds.checkIntervalMinutes,
          })
          .from(feeds)
          .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
          .where(
            and(
              isNull(feeds.deactivatedAt),
              or(
                isNull(feeds.lastFetchedAt),
                // last_fetched_at + interval_ms <= now
                lte(
                  sql`${feeds.lastFetchedAt} + ${feeds.checkIntervalMinutes} * 60000`,
                  now,
                ),
              ),
            ),
          )
          .orderBy(asc(sql`coalesce(${feeds.lastFetchedAt}, 0)`)),

        db
          .select({ count: sql<number>`count(*)` })
          .from(feeds)
          .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
          .where(isNull(feeds.deactivatedAt)),
      ]);

      return {
        dueFeeds: due,
        totalActiveFeeds: Number(activeCount[0]?.count ?? 0),
      };
    });

    logger.info("feed polling cycle starting", {
      totalActiveFeeds,
      dueFeeds: dueFeeds.length,
    });

    if (dueFeeds.length === 0) {
      logger.info("no feeds due, skipping cycle");
      return;
    }

    // ------------------------------------------------------------------
    // Steps 2…N — one step per batch of FEEDS_PER_STEP feeds.
    // Within each step, feeds are fetched concurrently to minimise wall time.
    // Sequential steps each run in a fresh Worker invocation with a new budget.
    // ------------------------------------------------------------------

    const allResults: FeedResult[] = [];

    for (let i = 0; i < dueFeeds.length; i += FEEDS_PER_STEP) {
      const batch = dueFeeds.slice(i, i + FEEDS_PER_STEP);
      const batchIndex = Math.floor(i / FEEDS_PER_STEP);

      const batchResults = await step.do(`fetch-batch-${batchIndex}`, async () => {
        const settled = await Promise.allSettled(
          batch.map((feed) => fetchAndStoreFeed(feed, this.env)),
        );

        return settled.map((s, j): FeedResult => {
          if (s.status === "fulfilled") return s.value;
          return {
            feedId: batch[j].id,
            feedTitle: batch[j].title ?? batch[j].feedUrl,
            status: "error",
            error: String(s.reason),
          };
        });
      });

      for (const r of batchResults) {
        if (r.status === "error") {
          logger.error("feed fetch failed", { feedId: r.feedId, feedTitle: r.feedTitle, error: r.error });
        }
        allResults.push(r);
      }
    }

    // ------------------------------------------------------------------
    // Final step — emit cycle analytics event
    // ------------------------------------------------------------------

    const newArticles = allResults.reduce((sum, r) => sum + (r.status === "ok" ? r.newItems : 0), 0);
    const failedFeeds = allResults.filter((r) => r.status === "error").length;

    await step.do("record-cycle", async () => {
      const metrics = createMetrics(this.env.READER_METRICS);
      metrics.recordCycle({
        totalActiveFeeds,
        dueFeeds: dueFeeds.length,
        checkedFeeds: allResults.length,
        newArticles,
        failedFeeds,
      });
    });

    const detail = allResults.map((r) => {
      if (r.status === "ok") return `${r.feedTitle}: +${r.newItems}`;
      if (r.status === "not_modified") return `${r.feedTitle}: no change`;
      return `${r.feedTitle}: error — ${r.error}`;
    });

    logger.info("feed polling cycle complete", {
      totalActiveFeeds,
      dueFeeds: dueFeeds.length,
      checkedFeeds: allResults.length,
      newArticles,
      failedFeeds,
      feeds: detail,
    });
  }
}
