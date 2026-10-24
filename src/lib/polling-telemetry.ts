import { Logger } from "@workers-powertools/logger";
import type { FeedAttemptCompletion } from "../feed/poll";

// Management cancellations must not inherit request-scoped User identity.
const pollingLogger = new Logger({ serviceName: "my-greader" });

/** Formats terminal evidence for both Workflow and management cancellation adapters. */
export function logFeedAttemptCompletion(
  attempt: FeedAttemptCompletion,
  log: Logger = pollingLogger,
): void {
  const context = {
    eventName: "feed_attempt_completed",
    cycleRunId: attempt.cycleRunId,
    attemptId: attempt.attemptId,
    feedId: attempt.feedId,
    outcome: attempt.outcome,
    errorClass: attempt.errorClass,
    httpStatus: attempt.httpStatus,
    parserStatus: attempt.parserStatus,
    newItems: attempt.newItems,
  };

  if (attempt.outcome === "failed") {
    log.error("feed polling attempt completed", {
      ...context,
      error: attempt.diagnostic,
    });

    return;
  }

  if (attempt.outcome === "rate_limited") {
    log.warn("feed polling attempt completed", context);

    return;
  }

  log.info("feed polling attempt completed", context);
}
