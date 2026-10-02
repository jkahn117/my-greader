// ---------------------------------------------------------------------------
// Timeline tab for Items and attempt diagnostics grouped by Cycle Run.
// ---------------------------------------------------------------------------

import { relativeTime } from "../lib/dates";
import type {
  ActivityAttempt,
  ActivityCycleRun,
  ActivityTimeline,
} from "../feed/activity";

/** Formats stable attempt fields without interpreting diagnostic text. */
function attemptLabel(attempt: ActivityAttempt): string {
  switch (attempt.outcome) {
    case "new_items":
      return "New Items";
    case "unchanged":
      return "No new Items";
    case "not_modified":
      return "Not modified";
    case "rate_limited":
      return "Rate limited";
    case "failed": {
      const errorClass =
        attempt.errorClass === "http"
          ? "HTTP"
          : (attempt.errorClass ?? "Unknown");
      return `${errorClass} failure${attempt.httpStatus != null ? `, HTTP ${attempt.httpStatus}` : ""}`;
    }
    case "skipped":
      return "Skipped";
    default:
      return "In progress";
  }
}

/** Renders one bounded Cycle Run projection with searchable attempt IDs. */
function CycleRunCard({ cycleRun }: { cycleRun: ActivityCycleRun }) {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-foreground">
            Cycle Run at {relativeTime(cycleRun.ranAt)}
          </h3>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {cycleRun.outcome === "empty" ? (
              "No eligible Feeds globally"
            ) : (
              <>
                Global: {cycleRun.globalSelectedFeeds} selected ·{" "}
                {cycleRun.globalCheckedFeeds} checked
                {cycleRun.globalFailedFeeds > 0 &&
                  ` · ${cycleRun.globalFailedFeeds} failed`}
                {cycleRun.globalSkippedFeeds > 0 &&
                  ` · ${cycleRun.globalSkippedFeeds} skipped`}
              </>
            )}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {cycleRun.globalNewItems} Item
            {cycleRun.globalNewItems === 1 ? "" : "s"} globally ·{" "}
            {cycleRun.subscribedItemCount} Item
            {cycleRun.subscribedItemCount === 1 ? "" : "s"} in your
            Subscriptions
          </p>
          {cycleRun.attributed ? (
            <p class="mt-1 text-xs text-muted-foreground">
              {cycleRun.triggerReason ?? "unknown trigger"} ·{" "}
              {cycleRun.status === "running"
                ? "In progress"
                : cycleRun.outcome === "empty"
                  ? "Completed empty"
                  : "Completed"}{" "}
              · {cycleRun.cycleRunId}
            </p>
          ) : (
            <p class="mt-1 text-xs text-muted-foreground">
              Legacy Cycle Run · exact Item attribution unavailable
            </p>
          )}
        </div>
      </div>

      {cycleRun.attempts.length > 0 && (
        <div class="border-b border-border divide-y divide-border">
          {cycleRun.attempts.map((attempt) => (
            <div class="px-4 py-2.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-medium text-foreground">
                    {attempt.feedTitle}
                  </p>
                  <p class="mt-0.5 text-xs text-muted-foreground break-all">
                    Attempt {attempt.id} · Feed {attempt.feedId}
                  </p>
                </div>
                <span class="shrink-0 text-xs text-muted-foreground">
                  {attemptLabel(attempt)}
                </span>
              </div>
              {attempt.diagnostic && (
                <p class="mt-1 text-xs text-destructive">
                  {attempt.diagnostic}
                </p>
              )}
              {attempt.parserStatus === "fallback" && (
                <p class="mt-1 text-xs text-muted-foreground">
                  Fallback parser used
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {cycleRun.items.length > 0 ? (
        <div class="divide-y divide-border">
          {cycleRun.items.map((item) => (
            <a
              href={item.itemUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-start justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm text-foreground truncate font-medium leading-snug">
                  {item.itemTitle ?? "Untitled"}
                </p>
                <p class="mt-0.5 text-xs text-muted-foreground truncate">
                  {item.feedTitle} · attempt {item.attemptId}
                </p>
              </div>
              <span class="shrink-0 text-xs text-muted-foreground pt-0.5">
                {item.publishedAt != null
                  ? relativeTime(item.publishedAt)
                  : "—"}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p class="px-4 py-3 text-sm text-muted-foreground">
          {cycleRun.attributed
            ? "No attributed Items in this Cycle Run."
            : "Historical Items remain unattributed."}
        </p>
      )}
    </div>
  );
}

export function TimelineTab({ timeline }: { timeline: ActivityTimeline }) {
  const unattributedMessage = `${timeline.unattributedItemCount} Item${timeline.unattributedItemCount === 1 ? "" : "s"} in your Subscriptions ${timeline.unattributedItemCount === 1 ? "has" : "have"} no retained Cycle Run attribution`;
  const unattributedExplanation = `${timeline.unattributedItemCount === 1 ? "Its" : "Their"} ingestion history expired or predates attribution tracking.`;

  if (timeline.cycleRuns.length === 0) {
    return (
      <div class="rounded-lg border border-border bg-card px-6 py-10 text-center shadow-sm">
        <p class="text-sm font-medium text-foreground">
          {timeline.historyStatus === "unavailable"
            ? "Cycle Run history unavailable"
            : "No Cycle Runs yet"}
        </p>
        <p class="mt-1 text-sm text-muted-foreground">
          {timeline.historyStatus === "unavailable"
            ? `${unattributedMessage}. ${unattributedExplanation}`
            : "Timeline appears after the first polling Cycle Run."}
        </p>
      </div>
    );
  }

  return (
    <div class="space-y-4">
      {timeline.unattributedItemCount > 0 && (
        <div class="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {unattributedMessage}. {unattributedExplanation}
        </div>
      )}
      {timeline.cycleRuns.map((cycleRun) => (
        <CycleRunCard cycleRun={cycleRun} />
      ))}
    </div>
  );
}
