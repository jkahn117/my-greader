import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { logger } from "../lib/logger";
import { tracer } from "../lib/tracer";
import { createMetrics } from "../lib/metrics";
import { feeds, subscriptions, cycleRuns } from "../db/schema";
import { fetchAndStoreFeed, FeedResult } from "../handlers/cron";

// No per-run parameters needed — the Workflow always fetches all due feeds
type Params = Record<string, never>;

// Each feed fetch costs 2 subrequests (1 HTTP + 1 D1 write).
// Sequential steps each get their own fresh subrequest budget (free plan: 50).
// Concurrent fan-out within a step shares the budget, so batch size = floor(50 / 2) - safety margin.
const FEEDS_PER_STEP = 20;

// ---------------------------------------------------------------------------
// asDisposable
//
// Background: inside a WorkflowEntrypoint, `this.env.DB` and similar bindings
// are not plain objects — at runtime they are RPC stubs (proxy objects) that
// hold an open connection back to the Cloudflare runtime. These stubs must be
// explicitly "disposed" (connection closed) when a step finishes, otherwise
// the runtime logs a warning: "RPC result not disposed".
//
// TypeScript's `using` declaration (TC39 Explicit Resource Management) handles
// disposal automatically: when a `using x = ...` variable goes out of scope,
// it calls `x[Symbol.dispose]()`. This requires the object to implement the
// `Disposable` interface (i.e. have a `[Symbol.dispose]` method).
//
// The problem: Cloudflare's TypeScript types for bindings like `D1Database` do
// not declare `[Symbol.dispose]`, even though the runtime object actually has
// it (the stub inherits it from `StubBase`). So TypeScript won't let you write
// `using d1 = this.env.DB` without an explicit cast.
//
// This safe version:
//   1. Checks at runtime whether [Symbol.dispose] is already present.
//   2. If yes — returns the binding as-is. Disposal will work normally.
//   3. If no  — adds a no-op [Symbol.dispose] directly onto the binding object
//      so `using` won't crash. The binding may not be "properly" disposed, but
//      the step won't crash.
// ---------------------------------------------------------------------------
function asDisposable<T extends object>(binding: T): T & Disposable {
  if (typeof (binding as unknown as Disposable)[Symbol.dispose] === "function") {
    return binding as T & Disposable;
  }
  (binding as T & Disposable)[Symbol.dispose] = () => {};
  return binding as T & Disposable;
}

// ---------------------------------------------------------------------------
// FeedPollingWorkflow
//
// Triggered every 30 minutes by the cron handler.
//
// Why Workflows instead of a plain cron handler?
// A single Worker invocation on the free plan has a budget of 50 subrequests.
// Each feed fetch costs ~2 (1 HTTP GET + 1 D1 batch write). A plain cron
// handler would hit the limit after ~25 feeds. Workflows solve this because
// each sequential step.do() runs in its own fresh Worker invocation with its
// own fresh 50-subrequest budget. There is no limit on the number of steps.
//
// Batching strategy:
//   - Feeds within a batch are fetched concurrently (Promise.allSettled) to
//     minimise wall time. Concurrent fetches within one step share that step's
//     budget, so batch size = floor(50 / 2) - safety margin = 20.
//   - Batches are processed sequentially (one step.do per batch), each in a
//     fresh invocation, so total feed count is not constrained by subrequests.
//
// Error handling:
//   - Individual feed failures are caught inside Promise.allSettled and
//     returned as FeedResult { status: "error" }. They do not fail the step.
//   - Step-level failures (e.g. D1 outage, binding error) will be retried by
//     the Workflow runtime before propagating.
//   - run() wraps everything in a try/catch that logs the full error message
//     and emits a cycle_error metric so failures are visible in the dashboard.
// ---------------------------------------------------------------------------

export class FeedPollingWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    // Use the Workflow instance ID as the correlation ID so all spans and
    // metrics emitted during this run are linkable across steps.
    tracer.setCorrelationId(event.instanceId);
    // withRpcContext enriches all log entries for this Workflow run with the
    // agent name and instance ID (no Request object is available in Workflows).
    using _ctx = logger.withRpcContext({
      agent: "FeedPollingWorkflow",
      instanceId: event.instanceId,
    });

    try {
      await this.#poll(step);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      // logger.error flushes the buffer — all buffered DEBUG/INFO logs emitted
      // before this point are now visible in structured logs alongside the error.
      logger.error("feed polling workflow failed", { error: errorMessage, stack });

      try {
        using metricsPipeline = asDisposable(this.env.METRICS_PIPELINE);
        const metrics = createMetrics(
          metricsPipeline as unknown as Env["METRICS_PIPELINE"],
          this.env.ANALYTICS_ENABLED !== "false",
        );
        metrics.recordCycleError({ error: errorMessage });
        await metrics.flush();
      } catch {
        // Don't mask the original error if metrics emission itself fails
      }

      throw err;
    }
  }

  async #poll(step: WorkflowStep): Promise<void> {

    // ------------------------------------------------------------------
    // Step 1 — query feeds that are due for a check
    // ------------------------------------------------------------------

    const { dueFeeds, totalActiveFeeds } = await step.do("get-due-feeds", async () => {
      return tracer.captureAsync("get-due-feeds", async () => {
      try {
        using d1 = asDisposable(this.env.DB);
        const db = getDb(d1);
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
              lastNewItemAt: feeds.lastNewItemAt,
            })
            .from(feeds)
            .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
            .where(
              and(
                isNull(feeds.deactivatedAt),
                or(
                  isNull(feeds.lastFetchedAt),
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
      } catch (err) {
        logger.error("get-due-feeds step failed", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      }
      }); // captureAsync
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
        return tracer.captureAsync("fetch-batch", async (span) => {
          span.annotations.batchIndex = String(batchIndex);
          span.annotations.batchSize = String(batch.length);
          try {
            using d1 = asDisposable(this.env.DB);
            using metricsPipeline = asDisposable(this.env.METRICS_PIPELINE);
            const stepEnv = {
              DB: d1,
              METRICS_PIPELINE: metricsPipeline,
              ANALYTICS_ENABLED: this.env.ANALYTICS_ENABLED,
            } as unknown as Env;

            const settled = await Promise.allSettled(
              batch.map((feed) => fetchAndStoreFeed(feed, stepEnv)),
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
          } catch (err) {
            logger.error(`fetch-batch-${batchIndex} step failed`, {
              batchIndex,
              batchSize: batch.length,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
            throw err;
          }
        }); // captureAsync
      });

      for (const r of batchResults) {
        if (r.status === "error") {
          logger.error("feed fetch failed", { feedId: r.feedId, feedTitle: r.feedTitle, error: r.error });
        }
        allResults.push(r);
      }
    }

    // ------------------------------------------------------------------
    // Final step — write cycle summary to D1 + emit Pipeline metrics
    // ------------------------------------------------------------------

    const newArticles = allResults.reduce((sum, r) => sum + (r.status === "ok" ? r.newItems : 0), 0);
    const failedFeeds = allResults.filter((r) => r.status === "error").length;

    const detail = allResults.map((r) => {
      if (r.status === "ok") return `${r.feedTitle}: +${r.newItems}`;
      if (r.status === "not_modified") return `${r.feedTitle}: no change`;
      return `${r.feedTitle}: error — ${r.error}`;
    });

    await step.do("record-cycle", async () => {
      return tracer.captureAsync("record-cycle", async () => {
      try {
        using d1 = asDisposable(this.env.DB);
        using metricsPipeline = asDisposable(this.env.METRICS_PIPELINE);
        const db = getDb(d1);
        const metrics = createMetrics(
          metricsPipeline as unknown as Env["METRICS_PIPELINE"],
          this.env.ANALYTICS_ENABLED !== "false",
        );
        const now = Date.now();

        // Write per-cycle row to D1 so the metrics dashboard can query it
        // without depending on Analytics Engine or an external API.
        await db.insert(cycleRuns).values({
          id: String(now),
          ranAt: now,
          activeFeeds: totalActiveFeeds,
          dueFeeds: dueFeeds.length,
          checkedFeeds: allResults.length,
          newItems: newArticles,
          failedFeeds,
        }).onConflictDoNothing(); // guard against duplicate step execution

        // Pipeline write for long-term analytics — batched with flush
        metrics.recordCycle({
          totalActiveFeeds,
          dueFeeds: dueFeeds.length,
          checkedFeeds: allResults.length,
          newArticles,
          failedFeeds,
        });
        await metrics.flush();
      } catch (err) {
        logger.error("record-cycle step failed", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      }

      return {
        totalActiveFeeds,
        dueFeeds: dueFeeds.length,
        checkedFeeds: allResults.length,
        newArticles,
        failedFeeds,
        feeds: detail,
      };
      }); // captureAsync
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
