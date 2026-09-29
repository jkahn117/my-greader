// ---------------------------------------------------------------------------
// Timeline tab — articles grouped by polling cycle, most recent first
// ---------------------------------------------------------------------------

import { relativeTime } from "../lib/dates";
import type {
  FeedAttemptErrorClass,
  FeedAttemptOutcome,
  FeedAttemptParserStatus,
} from "../db/schema";

export interface TimelineItem {
  itemTitle: string | null;
  itemUrl: string | null;
  publishedAt: number | null;
  feedTitle: string;
  attemptId: string;
}

export interface TimelineAttempt {
  id: string;
  feedTitle: string;
  outcome: FeedAttemptOutcome | null;
  errorClass: FeedAttemptErrorClass | null;
  httpStatus: number | null;
  parserStatus: FeedAttemptParserStatus | null;
  diagnostic: string | null;
}

export interface CycleTimeline {
  cycleId: string;
  ranAt: number;
  selectedFeeds: number;
  checkedFeeds: number;
  failedFeeds: number;
  skippedFeeds: number;
  newItems: number;
  triggerReason: "scheduled" | "manual" | "forced" | null;
  status: "running" | "completed" | null;
  outcome: "completed" | "empty" | null;
  attributed: boolean;
  attempts: TimelineAttempt[];
  items: TimelineItem[];
}

/** Formats stable attempt fields without interpreting diagnostic text. */
function attemptLabel(attempt: TimelineAttempt): string {
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

function CycleCard({ cycle }: { cycle: CycleTimeline }) {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-foreground">
            Cycle at {relativeTime(cycle.ranAt)}
          </h3>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {cycle.outcome === "empty" ? (
              "No eligible Feeds"
            ) : (
              <>
                {cycle.selectedFeeds} selected · {cycle.checkedFeeds} checked
                {cycle.failedFeeds > 0 && ` · ${cycle.failedFeeds} failed`}
                {cycle.skippedFeeds > 0 && ` · ${cycle.skippedFeeds} skipped`}
                {cycle.newItems > 0 && (
                  <span class="ml-1 text-primary font-medium">
                    · +{cycle.newItems} article{cycle.newItems !== 1 ? "s" : ""}
                  </span>
                )}
              </>
            )}
          </p>
          {cycle.attributed ? (
            <p class="mt-1 text-xs text-muted-foreground">
              {cycle.triggerReason ?? "unknown trigger"} ·{" "}
              {cycle.status === "running"
                ? "In progress"
                : cycle.outcome === "empty"
                  ? "Completed empty"
                  : "Completed"}{" "}
              · {cycle.cycleId}
            </p>
          ) : (
            <p class="mt-1 text-xs text-muted-foreground">
              Legacy cycle · exact Item attribution unavailable
            </p>
          )}
        </div>
      </div>

      {cycle.attempts.length > 0 && (
        <div class="border-b border-border divide-y divide-border">
          {cycle.attempts.map((attempt) => (
            <div class="px-4 py-2.5">
              <div class="flex items-start justify-between gap-3">
                <p class="text-sm font-medium text-foreground">
                  {attempt.feedTitle}
                </p>
                <span class="text-xs text-muted-foreground">
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

      {cycle.items.length > 0 ? (
        <div class="divide-y divide-border">
          {cycle.items.map((item) => (
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
          {cycle.attributed
            ? "No attributed Items in this cycle."
            : "Historical Items remain unattributed."}
        </p>
      )}
    </div>
  );
}

export function TimelineTab({ cycles }: { cycles: CycleTimeline[] }) {
  if (cycles.length === 0) {
    return (
      <div class="rounded-lg border border-border bg-card px-6 py-10 text-center shadow-sm">
        <p class="text-sm font-medium text-foreground">No cycles yet</p>
        <p class="mt-1 text-sm text-muted-foreground">
          Timeline appears after the first polling cycle runs.
        </p>
      </div>
    );
  }

  return (
    <div class="space-y-4">
      {cycles.map((c) => (
        <CycleCard cycle={c} />
      ))}
    </div>
  );
}
