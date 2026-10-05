// ---------------------------------------------------------------------------
// Timeline tab — articles grouped by polling cycle, most recent first
// ---------------------------------------------------------------------------

import { relativeTime } from "../lib/dates";

export interface TimelineItem {
  itemTitle: string | null;
  itemUrl: string | null;
  publishedAt: number | null;
  feedTitle: string;
}

export interface CycleTimelineWindow {
  cycleId: string;
  ranAt: number;
  checkedFeeds: number;
  newItems: number;
  items: TimelineItem[];
}

function CycleCard({ cycle }: { cycle: CycleTimelineWindow }) {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-foreground">
            Cycle at {relativeTime(cycle.ranAt)}
          </h3>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {cycle.checkedFeeds} feed{cycle.checkedFeeds !== 1 ? "s" : ""} checked
            {cycle.newItems > 0 && (
              <span class="ml-1 text-primary font-medium">· +{cycle.newItems} article{cycle.newItems !== 1 ? "s" : ""}</span>
            )}
          </p>
        </div>
      </div>

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
                  {item.feedTitle}
                </p>
              </div>
              <span class="shrink-0 text-xs text-muted-foreground pt-0.5">
                {item.publishedAt != null ? relativeTime(item.publishedAt) : "—"}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p class="px-4 py-3 text-sm text-muted-foreground">No new articles this cycle.</p>
      )}
    </div>
  );
}

export function TimelineTab({ cycles }: { cycles: CycleTimelineWindow[] }) {
  if (cycles.length === 0) {
    return (
      <div class="rounded-lg border border-border bg-card px-6 py-10 text-center shadow-sm">
        <p class="text-sm font-medium text-foreground">No cycles yet</p>
        <p class="mt-1 text-sm text-muted-foreground">Timeline appears after the first polling cycle runs.</p>
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
