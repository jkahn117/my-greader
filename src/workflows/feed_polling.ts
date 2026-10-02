import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { logger } from "../lib/logger";
import { createMetrics, ParseStatus } from "../lib/metrics";
import {
  cycleRuns,
  feedPollAttempts,
  feeds,
  subscriptions,
} from "../db/schema";
import {
  createFeedPoller,
  type FeedPollResult,
  type FeedTransport,
  type PollObserver,
  type PollTriggerReason,
} from "../feed/poll";

type Params = { force?: boolean; triggerReason?: PollTriggerReason };

// Each Feed uses up to four subrequests: attempt start/replay check, HTTP,
// atomic D1 completion, and committed-result read. Eight concurrent Feeds stay
// below the 50-subrequest budget with headroom for metrics delivery.
const FEEDS_PER_STEP = 8;

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
  if (
    typeof (binding as unknown as Disposable)[Symbol.dispose] === "function"
  ) {
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
// Each Feed poll uses several D1 and HTTP subrequests. A plain cron handler
// would hit the invocation limit. Workflows solve this because
// each sequential step.do() runs in its own fresh Worker invocation with its
// own fresh 50-subrequest budget. There is no limit on the number of steps.
//
// Batching strategy:
//   - Feeds within a batch are fetched concurrently (Promise.allSettled) to
//     minimise wall time. Concurrent fetches within one step share that step's
//     budget, so the batch size leaves room for five subrequests per Feed.
//   - Batches are processed sequentially (one step.do per batch), each in a
//     fresh invocation, so total feed count is not constrained by subrequests.
//
// Error handling:
//   - Individual feed failures are caught inside Promise.allSettled and
//     returned as a terminal FeedPollResult. They do not fail the step.
//   - Step-level failures (e.g. D1 outage, binding error) will be retried by
//     the Workflow runtime before propagating.
//   - run() wraps everything in a try/catch that logs the full error message
//     and emits a cycle_error metric so failures are visible in the dashboard.
// ---------------------------------------------------------------------------

export class FeedPollingWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    return runFeedPollingWorkflow(this.env, event, step);
  }
}

/** Runs the Workflow adapter through an exported seam shared with local tests. */
export async function runFeedPollingWorkflow(
  env: Env,
  event: WorkflowEvent<Params>,
  step: WorkflowStep,
): Promise<void> {
  using _ctx = logger.withRpcContext({
    correlationId: event.instanceId,
    agent: "FeedPollingWorkflow",
    instanceId: event.instanceId,
    extra: { cycleRunId: event.instanceId },
  });

  try {
    // `force` remains a read-only compatibility field for Workflows started
    // before triggerReason became the single source of selection policy.
    const triggerReason =
      event.payload.triggerReason ??
      (event.payload.force === true ? "forced" : "scheduled");
    await pollWorkflow(env, step, triggerReason, event.instanceId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error("feed polling workflow failed", {
      error: errorMessage,
      stack,
    });

    try {
      using analytics = asDisposable(env.ANALYTICS);
      const metrics = createMetrics(
        analytics as unknown as Env["ANALYTICS"],
        (env.ANALYTICS_ENABLED as string) !== "false",
      );
      metrics.recordCycleError({ error: errorMessage });
      await metrics.flush();
    } catch {
      // Do not mask the domain or infrastructure failure with metrics delivery.
    }

    throw err;
  }
}

/** Coordinates selection and step placement while FeedPoller owns Feed policy. */
async function pollWorkflow(
  env: Env,
  step: WorkflowStep,
  triggerReason: PollTriggerReason,
  cycleRunId: string,
): Promise<void> {
  // ------------------------------------------------------------------
  // Step 1 — query feeds that are due for a check (or all active feeds when forced)
  // ------------------------------------------------------------------

  const force = triggerReason === "forced";
  const stepName = force ? "get-all-active-feeds" : "get-due-feeds";

  const { dueFeeds, totalActiveFeeds } = await step.do(stepName, async () => {
    try {
      using d1 = asDisposable(env.DB);
      const db = getDb(d1);
      const now = Date.now();

      const dueQuery = db
        .selectDistinct({
          id: feeds.id,
          feedUrl: feeds.feedUrl,
          title: feeds.title,
          htmlUrl: feeds.htmlUrl,
          etag: feeds.etag,
          lastModified: feeds.lastModified,
          lastSuccessfulPollAt: feeds.lastSuccessfulPollAt,
          lastNewItemDiscoveredAt: feeds.lastNewItemDiscoveredAt,
          initialBackloadCompletedAt: feeds.initialBackloadCompletedAt,
          nextPollAt: feeds.nextPollAt,
          consecutiveErrors: feeds.consecutiveErrors,
          checkIntervalMinutes: feeds.checkIntervalMinutes,
        })
        .from(feeds)
        .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
        .where(
          force
            ? isNull(feeds.deactivatedAt)
            : and(
                isNull(feeds.deactivatedAt),
                or(isNull(feeds.nextPollAt), lte(feeds.nextPollAt, now)),
              ),
        )
        .orderBy(asc(sql`coalesce(${feeds.nextPollAt}, 0)`));

      const [due, activeCount] = await db.batch([
        dueQuery,
        db
          .select({ count: sql<number>`count(distinct ${feeds.id})` })
          .from(feeds)
          .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
          .where(isNull(feeds.deactivatedAt)),
      ]);

      const totalActiveFeeds = Number(activeCount[0]?.count ?? 0);
      const empty = due.length === 0;
      await db
        .insert(cycleRuns)
        .values({
          id: cycleRunId,
          ranAt: now,
          startedAt: now,
          completedAt: empty ? now : null,
          triggerReason,
          status: empty ? "completed" : "running",
          outcome: empty ? "empty" : null,
          activeFeeds: totalActiveFeeds,
          dueFeeds: due.length,
          selectedFeeds: due.length,
        })
        .onConflictDoNothing();

      return {
        dueFeeds: due,
        totalActiveFeeds,
      };
    } catch (err) {
      logger.error("get-due-feeds step failed", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
  });

  logger.info("feed polling cycle starting", {
    cycleRunId,
    totalActiveFeeds,
    dueFeeds: dueFeeds.length,
  });

  if (dueFeeds.length === 0) {
    logger.info("no feeds due, skipping cycle", { cycleRunId });
    return;
  }

  // ------------------------------------------------------------------
  // Steps 2…N — one step per batch of FEEDS_PER_STEP feeds.
  // Within each step, feeds are fetched concurrently to minimise wall time.
  // Sequential steps each run in a fresh Worker invocation with a new budget.
  // ------------------------------------------------------------------

  for (let i = 0; i < dueFeeds.length; i += FEEDS_PER_STEP) {
    const batch = dueFeeds.slice(i, i + FEEDS_PER_STEP);
    const batchIndex = Math.floor(i / FEEDS_PER_STEP);

    await step.do(`fetch-batch-${batchIndex}`, async () => {
      try {
        using d1 = asDisposable(env.DB);
        using analytics = asDisposable(env.ANALYTICS);
        const metrics = createMetrics(
          analytics as unknown as Env["ANALYTICS"],
          (env.ANALYTICS_ENABLED as string) !== "false",
        );

        const transport: FeedTransport = {
          get(url, headers) {
            return fetch(url, {
              headers,
              signal: AbortSignal.timeout(15000),
            });
          },
        };

        const observer: PollObserver = {
          publish(event) {
            switch (event.kind) {
              case "feedPolled":
                metrics.recordParse({
                  feedId: event.feedId,
                  status:
                    event.parseStatus === "fallback"
                      ? ParseStatus.FALLBACK
                      : ParseStatus.SUCCESS,
                  durationMs: event.durationMs,
                  articleCount: event.newItems,
                });
                break;
              case "feedNotModified":
                break;
              case "feedRateLimited":
                metrics.recordFetchError({
                  feedId: event.feedId,
                  httpStatus: 429,
                });
                break;
              case "feedFetchFailed":
                if (event.status) {
                  metrics.recordFetchError({
                    feedId: event.feedId,
                    httpStatus: event.status,
                  });
                }
                break;
              case "feedParseFailed":
                metrics.recordParse({
                  feedId: event.feedId,
                  status: ParseStatus.FAILURE,
                  durationMs: 0,
                  error: event.error,
                });
                break;
              case "feedDeactivated":
                break;
            }
          },
        };

        const poller = createFeedPoller(d1, transport, observer, () =>
          Date.now(),
        );

        const settled = await Promise.allSettled(
          batch.map((feed) =>
            poller.poll(feed, {
              cycleRunId,
              attemptId: attemptIdFor(cycleRunId, feed.id),
            }),
          ),
        );

        try {
          await metrics.flush();
        } catch (err) {
          logger.warn("Feed metrics delivery failed", {
            cycleRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        for (const result of settled) {
          if (result.status === "fulfilled") {
            logAttemptResult(cycleRunId, result.value);
          }
        }
        const rejected = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (rejected) throw rejected.reason;
      } catch (err) {
        logger.error(`fetch-batch-${batchIndex} step failed`, {
          batchIndex,
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      }
    });
  }

  // ------------------------------------------------------------------
  // Final step — write cycle summary to D1 + emit Pipeline metrics
  // ------------------------------------------------------------------

  const summary = await step.do("record-cycle", async () => {
    try {
      using d1 = asDisposable(env.DB);
      using analytics = asDisposable(env.ANALYTICS);
      const db = getDb(d1);
      const metrics = createMetrics(
        analytics as unknown as Env["ANALYTICS"],
        (env.ANALYTICS_ENABLED as string) !== "false",
      );
      const now = Date.now();
      const attempts = await db
        .select({
          outcome: feedPollAttempts.outcome,
          newItems: feedPollAttempts.newItems,
        })
        .from(feedPollAttempts)
        .where(eq(feedPollAttempts.cycleRunId, cycleRunId));
      const terminalAttempts = attempts.filter(
        (attempt) => attempt.outcome != null,
      );
      if (
        attempts.length !== dueFeeds.length ||
        terminalAttempts.length !== dueFeeds.length
      ) {
        throw new Error(`Cycle Run ${cycleRunId} has incomplete Feed attempts`);
      }

      const skippedFeeds = terminalAttempts.filter(
        (attempt) => attempt.outcome === "skipped",
      ).length;
      const checkedFeeds = terminalAttempts.length - skippedFeeds;
      const failedFeeds = terminalAttempts.filter(
        (attempt) => attempt.outcome === "failed",
      ).length;
      const newArticles = terminalAttempts.reduce(
        (sum, attempt) => sum + attempt.newItems,
        0,
      );

      // Durable attempts are the only source for the completed summary.
      await db
        .update(cycleRuns)
        .set({
          completedAt: now,
          status: "completed",
          outcome: "completed",
          activeFeeds: totalActiveFeeds,
          dueFeeds: dueFeeds.length,
          selectedFeeds: dueFeeds.length,
          checkedFeeds,
          newItems: newArticles,
          failedFeeds,
          skippedFeeds,
        })
        .where(
          and(eq(cycleRuns.id, cycleRunId), eq(cycleRuns.status, "running")),
        );

      metrics.recordCycle({
        totalActiveFeeds,
        dueFeeds: dueFeeds.length,
        checkedFeeds,
        newArticles,
        failedFeeds,
      });
      try {
        await metrics.flush();
      } catch (err) {
        logger.warn("Cycle metrics delivery failed", {
          cycleRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        checkedFeeds,
        newItems: newArticles,
        failedFeeds,
        skippedFeeds,
      };
    } catch (err) {
      logger.error("record-cycle step failed", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
  });

  logger.info("feed polling cycle complete", {
    cycleRunId,
    totalActiveFeeds,
    selectedFeeds: dueFeeds.length,
    checkedFeeds: summary.checkedFeeds,
    newArticles: summary.newItems,
    failedFeeds: summary.failedFeeds,
    skippedFeeds: summary.skippedFeeds,
  });
}

/** Emits one searchable terminal log for every durable Feed attempt. */
function logAttemptResult(cycleRunId: string, result: FeedPollResult): void {
  const context = {
    cycleRunId,
    attemptId: attemptIdFor(cycleRunId, result.feedId),
    feedId: result.feedId,
    feedTitle: result.feedTitle,
    outcome: result.outcome,
  };
  if (result.outcome === "failed") {
    logger.error("feed polling attempt completed", {
      ...context,
      errorClass: result.errorClass,
      error: result.error,
    });
    return;
  }
  if (result.outcome === "rate_limited") {
    logger.warn("feed polling attempt completed", context);
    return;
  }
  logger.info("feed polling attempt completed", {
    ...context,
    ...((result.outcome === "new_items" || result.outcome === "unchanged") && {
      newItems: result.newItems,
    }),
  });
}

/** Builds the durable logical attempt ID reused by Workflow step retries. */
function attemptIdFor(cycleRunId: string, feedId: string): string {
  return `${cycleRunId}:${feedId}`;
}
