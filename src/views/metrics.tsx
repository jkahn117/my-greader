// ---------------------------------------------------------------------------
// Metrics tab — dashboard backed by D1 (cycle_runs, feeds, item_state)
// ---------------------------------------------------------------------------

import { relativeTime, shortUtc } from "../lib/dates";

// ---------------------------------------------------------------------------
// Shared types (exported so the handler can construct typed data objects)
// ---------------------------------------------------------------------------

export interface CycleRun {
  id: string;
  ranAt: number;
  activeFeeds: number;
  dueFeeds: number;
  checkedFeeds: number;
  newItems: number;
  failedFeeds: number;
}

export interface FeedHealthRow {
  feedId: string;
  title: string;
  consecutiveErrors: number;
  lastError: string | null;
  lastFetchedAt: number | null;
  deactivatedAt: number | null;
  checkIntervalMinutes: number;
  rateLimited: boolean;
}

export interface ReadsByDay {
  date: string;
  reads: number;
}

interface IntervalDistRow {
  minutes: number;
  count: number;
}

interface StatusData {
  cycles: CycleRun[];
  intervalDist: IntervalDistRow[];
  totalArticles: number;
  newArticles7d: number;
  feedHealth: FeedHealthRow[];
  readsByDay: ReadsByDay[];
  tz: string;
}

// ---------------------------------------------------------------------------
// Stat card — single KPI tile
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div class="rounded-lg border border-border bg-card px-6 py-5 shadow-sm">
      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p class="mt-1 text-3xl font-semibold text-foreground">{value}</p>
      {sub && <p class="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cycle timeline — per-run bar chart of new articles
// ---------------------------------------------------------------------------

function CycleTimelineCard({ cycles }: { cycles: CycleRun[] }) {
  if (cycles.length === 0) {
    return (
      <div class="rounded-lg border border-border bg-card shadow-sm">
        <div class="border-b border-border px-6 py-4">
          <h2 class="text-base font-semibold text-foreground">Polling cycles</h2>
        </div>
        <p class="px-6 py-6 text-center text-sm text-muted-foreground">
          No cycle data yet — appears after the first Workflow run.
        </p>
      </div>
    );
  }

  // Show most-recent-first; compute aggregate stats over visible window
  const recent = cycles.slice(0, 20);
  const maxNew = Math.max(...recent.map((c) => c.newItems), 1);
  const totalNew7d = recent.reduce((s, c) => s + c.newItems, 0);
  const avgNew = (totalNew7d / recent.length).toFixed(1);
  const anyFailed = recent.some((c) => c.failedFeeds > 0);

  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 class="text-base font-semibold text-foreground">
            Polling cycles{" "}
            <span class="text-muted-foreground font-normal text-sm">
              (last {recent.length})
            </span>
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {totalNew7d} new articles · avg {avgNew}/cycle
            {anyFailed && (
              <span class="ml-2 text-destructive font-medium">
                · some cycles had feed errors
              </span>
            )}
          </p>
        </div>
        <div class="grid grid-cols-3 gap-4 text-center shrink-0">
          {[
            { label: "Active feeds", value: recent[0]?.activeFeeds ?? 0 },
            { label: "Avg due/cycle", value: (recent.reduce((s, c) => s + c.dueFeeds, 0) / recent.length).toFixed(1) },
            { label: "Avg failed/cycle", value: (recent.reduce((s, c) => s + c.failedFeeds, 0) / recent.length).toFixed(1) },
          ].map(({ label, value }) => (
            <div>
              <p class="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p class="mt-0.5 text-lg font-semibold text-foreground">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Bar chart — one bar per cycle, newest on the right */}
      <div class="px-6 py-4">
        <div class="flex items-end gap-0.5 h-24 w-full">
          {[...recent].reverse().map((c) => {
            const pct = maxNew > 0 ? Math.max((c.newItems / maxNew) * 100, 2) : 2;
            const barColor = c.failedFeeds > 0
              ? "bg-destructive/60"
              : c.newItems > 0
                ? "bg-primary"
                : "bg-muted-foreground/30";
            return (
              <div
                class="flex-1 min-w-0 rounded-t cursor-default"
                style={`height:${pct}%`}
                title={`${shortUtc(c.ranAt)}: ${c.newItems} new, ${c.checkedFeeds} checked${c.failedFeeds > 0 ? `, ${c.failedFeeds} failed` : ""}`}
              >
                <div class={`h-full w-full rounded-t ${barColor}`} />
              </div>
            );
          })}
        </div>
        <div class="flex justify-between mt-1 text-xs text-muted-foreground">
          <span>{shortUtc([...recent].reverse()[0]?.ranAt)}</span>
          <span>newest →</span>
        </div>
      </div>

      {/* Last 5 cycle rows */}
      <div class="border-t border-border">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="px-6 pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">When</th>
              <th class="px-4 pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Checked</th>
              <th class="px-4 pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">New</th>
              <th class="px-6 pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Failed</th>
            </tr>
          </thead>
          <tbody>
            {recent.slice(0, 5).map((c) => (
              <tr class="border-b border-border last:border-0">
                <td class="px-6 py-2 text-muted-foreground whitespace-nowrap">
                  {relativeTime(c.ranAt)}
                </td>
                <td class="px-4 py-2 text-right text-foreground">{c.checkedFeeds}</td>
                <td class="px-4 py-2 text-right text-foreground font-medium">
                  {c.newItems > 0 ? (
                    <span class="text-primary">+{c.newItems}</span>
                  ) : (
                    <span class="text-muted-foreground">0</span>
                  )}
                </td>
                <td class="px-6 py-2 text-right">
                  {c.failedFeeds > 0 ? (
                    <span class="text-destructive font-medium">{c.failedFeeds}</span>
                  ) : (
                    <span class="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed health — error/rate-limited state from D1
// ---------------------------------------------------------------------------

function FeedHealthCard({ rows }: { rows: FeedHealthRow[] }) {
  const erroring = rows.filter((r) => r.consecutiveErrors > 0 && !r.deactivatedAt);
  const deactivated = rows.filter((r) => !!r.deactivatedAt);
  const rateLimited = rows.filter((r) => r.rateLimited && !r.deactivatedAt);

  if (erroring.length === 0 && deactivated.length === 0) return null;

  return (
    <div class="rounded-lg border border-destructive/40 bg-card shadow-sm">
      <div class="border-b border-destructive/40 px-6 py-4 flex items-center gap-3 flex-wrap">
        <h2 class="text-base font-semibold text-foreground">Feed health</h2>
        {erroring.length > 0 && (
          <span class="inline-flex items-center rounded-full bg-yellow-500/10 px-2.5 py-1 text-xs font-medium text-yellow-700">
            {erroring.length} erroring
          </span>
        )}
        {rateLimited.length > 0 && (
          <span class="inline-flex items-center rounded-full bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-700">
            {rateLimited.length} rate limited
          </span>
        )}
        {deactivated.length > 0 && (
          <span class="inline-flex items-center rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
            {deactivated.length} deactivated
          </span>
        )}
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Feed</th>
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Status</th>
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Last error</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Last fetched</th>
            </tr>
          </thead>
          <tbody>
            {[...erroring, ...deactivated].map((r) => (
              <tr class="border-b border-border last:border-0">
                <td class="py-3 pr-4 font-medium text-foreground truncate max-w-48" title={r.feedId}>
                  {r.title}
                </td>
                <td class="py-3 pr-4 whitespace-nowrap">
                  {r.deactivatedAt ? (
                    <span class="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      Deactivated
                    </span>
                  ) : r.rateLimited ? (
                    <span class="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700">
                      Rate limited
                    </span>
                  ) : (
                    <span class="inline-flex items-center rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-700">
                      {r.consecutiveErrors} error{r.consecutiveErrors !== 1 ? "s" : ""}
                    </span>
                  )}
                </td>
                <td class="py-3 pr-4 font-mono text-xs text-muted-foreground truncate max-w-64" title={r.lastError ?? undefined}>
                  {r.lastError ?? "—"}
                </td>
                <td class="py-3 text-right text-muted-foreground whitespace-nowrap">
                  {relativeTime(r.lastFetchedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reads by day — from item_state.read_at
// ---------------------------------------------------------------------------

function ReadsByDayCard({ rows }: { rows: ReadsByDay[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Reads by day{" "}
          <span class="text-muted-foreground font-normal text-sm">(last 7 days)</span>
        </h2>
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Date</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Articles read</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr class="border-b border-border last:border-0">
                <td class="py-3 pr-4 text-foreground">{r.date}</td>
                <td class="py-3 text-right text-foreground font-medium">{r.reads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Poll interval distribution — how backed-off the feed fleet is
// ---------------------------------------------------------------------------

function intervalLabel(minutes: number): string {
  if (minutes <= 30) return "30 min";
  if (minutes <= 60) return "1 h";
  if (minutes <= 120) return "2 h";
  if (minutes <= 240) return "4 h";
  return `${minutes} min`;
}

function PollIntervalDistCard({ rows }: { rows: IntervalDistRow[] }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Poll interval distribution{" "}
          <span class="text-muted-foreground font-normal text-sm">(active feeds)</span>
        </h2>
      </div>
      <div class="px-6 py-4 space-y-3">
        {rows.map((r) => {
          const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
          const barClass = r.minutes <= 30
            ? "bg-green-500"
            : r.minutes <= 120
              ? "bg-yellow-400"
              : "bg-orange-400";
          return (
            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="text-foreground font-medium">{intervalLabel(r.minutes)}</span>
                <span class="text-muted-foreground">
                  {r.count} feed{r.count !== 1 ? "s" : ""} · {pct}%
                </span>
              </div>
              <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div class={`h-full rounded-full ${barClass}`} style={`width:${pct}%`} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unconfigured placeholder
// ---------------------------------------------------------------------------

export function MetricsUnconfigured() {
  return (
    <div class="rounded-lg border border-border bg-card px-6 py-10 text-center shadow-sm">
      <p class="text-sm font-medium text-foreground">Metrics unavailable</p>
      <p class="mt-1 text-sm text-muted-foreground">
        Could not connect to the database.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full Metrics tab
// ---------------------------------------------------------------------------

export function MetricsTab({ data }: { data: StatusData }) {
  const totalReads7d = data.readsByDay.reduce((s, r) => s + r.reads, 0);
  const lastCycle = data.cycles[0];

  return (
    <div class="space-y-8">
      {/* KPI row */}
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total articles" value={data.totalArticles.toLocaleString()} />
        <StatCard
          label="New this week"
          value={data.newArticles7d}
          sub="articles fetched in last 7 days"
        />
        <StatCard
          label="Reads (7d)"
          value={totalReads7d}
          sub={totalReads7d === 0 ? "reads tracked after this update" : undefined}
        />
        <StatCard
          label="Last cycle"
          value={lastCycle ? `+${lastCycle.newItems}` : "—"}
          sub={lastCycle ? relativeTime(lastCycle.ranAt) ?? undefined : "no cycles yet"}
        />
      </div>

      <CycleTimelineCard cycles={data.cycles} />
      <FeedHealthCard rows={data.feedHealth} />
      <PollIntervalDistCard rows={data.intervalDist} />
      <ReadsByDayCard rows={data.readsByDay} />
    </div>
  );
}
