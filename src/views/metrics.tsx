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
  lastNewItemAt: number | null;
  deactivatedAt: number | null;
  checkIntervalMinutes: number;
  rateLimited: boolean;
}

export interface FeedActivityRow {
  feedId: string;
  title: string;
  count7d: number;
  lastNewItemAt: number | null;
}

export interface ReadsByDay {
  date: string;
  reads: number;
}

// R2 SQL analytics types — populated when ANALYTICS_ENABLED and R2_SQL_AUTH_TOKEN are set
export interface R2FeedVelocityRow {
  feedId: string;
  title: string;
  total30d: number;
  avgPerFetch: number;
}

export interface R2FetchPerfRow {
  feedId: string;
  title: string;
  samples: number;
  avgMs: number;
  maxMs: number;
}

export interface R2ErrorRateRow {
  httpStatus: string;
  occurrences: number;
  affectedFeeds: number;
}

export interface R2ArticleTrendRow {
  day: string;
  newArticles: number;
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
  feedActivity: FeedActivityRow[];
  readsByDay: ReadsByDay[];
  tz: string;
  // R2 SQL analytics — empty arrays when analytics disabled
  analyticsEnabled: boolean;
  r2Velocity: R2FeedVelocityRow[];
  r2FetchPerf: R2FetchPerfRow[];
  r2ErrorRates: R2ErrorRateRow[];
  r2Trend30d: R2ArticleTrendRow[];
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

  // Show most-recent-first; compute aggregate stats over visible window (~24h)
  const recent = cycles.slice(0, 48);
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
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Last new item</th>
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
                <td class="py-3 pr-4 text-right text-muted-foreground whitespace-nowrap">
                  {r.lastNewItemAt ? relativeTime(r.lastNewItemAt) : "—"}
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
// Reads by day — bar chart from item_state.read_at
// ---------------------------------------------------------------------------

function ReadsByDayCard({ rows }: { rows: ReadsByDay[] }) {
  if (rows.length === 0) return null;
  // rows arrive newest-first; reverse for left-to-right chronological display
  const ordered = [...rows].reverse();
  const maxReads = Math.max(...ordered.map((r) => r.reads), 1);
  const total = ordered.reduce((s, r) => s + r.reads, 0);

  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold text-foreground">
            Reads by day{" "}
            <span class="text-muted-foreground font-normal text-sm">(last 7 days)</span>
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{total} articles read</p>
        </div>
      </div>
      <div class="px-6 py-4">
        <div class="flex items-end gap-1 h-24 w-full">
          {ordered.map((r) => {
            const pct = Math.max((r.reads / maxReads) * 100, r.reads > 0 ? 4 : 0);
            return (
              <div
                class="flex-1 min-w-0 flex flex-col items-center gap-1"
                title={`${r.date}: ${r.reads} read`}
              >
                <div class="w-full rounded-t bg-primary" style={`height:${pct * 0.96}px; min-height:${r.reads > 0 ? "3px" : "0"}`} />
              </div>
            );
          })}
        </div>
        <div class="flex justify-between mt-2 text-xs text-muted-foreground">
          {ordered.map((r) => (
            <span class="flex-1 text-center">{r.date.slice(5)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed activity — top publishers in the last 7 days (D1)
// ---------------------------------------------------------------------------

function FeedActivityCard({ rows }: { rows: FeedActivityRow[] }) {
  if (rows.length === 0) return null;
  const maxCount = Math.max(...rows.map((r) => r.count7d), 1);

  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Feed activity{" "}
          <span class="text-muted-foreground font-normal text-sm">(new articles, last 7 days)</span>
        </h2>
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Feed</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">New (7d)</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Last item</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = maxCount > 0 ? Math.round((r.count7d / maxCount) * 100) : 0;
              return (
                <tr class="border-b border-border last:border-0">
                  <td class="py-2.5 pr-4 text-foreground max-w-0 w-full">
                    <div class="truncate font-medium" title={r.feedId}>{r.title}</div>
                    {/* inline sparkbar showing relative volume */}
                    <div class="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden">
                      <div class="h-full rounded-full bg-primary/50" style={`width:${pct}%`} />
                    </div>
                  </td>
                  <td class="py-2.5 pr-4 text-right font-medium text-foreground whitespace-nowrap">
                    {r.count7d > 0 ? (
                      <span class="text-primary">+{r.count7d}</span>
                    ) : (
                      <span class="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td class="py-2.5 text-right text-muted-foreground whitespace-nowrap">
                    {r.lastNewItemAt ? relativeTime(r.lastNewItemAt) : "—"}
                  </td>
                </tr>
              );
            })}
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
// R2 SQL analytics cards
// ---------------------------------------------------------------------------

function R2SectionHeader({ children }: { children: string }) {
  return (
    <div class="flex items-center gap-3">
      <div class="h-px flex-1 bg-border" />
      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
        {children}
      </p>
      <div class="h-px flex-1 bg-border" />
    </div>
  );
}

function R2VelocityCard({ rows }: { rows: R2FeedVelocityRow[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.total30d), 1);
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Feed velocity{" "}
          <span class="text-muted-foreground font-normal text-sm">(new articles, last 30 days)</span>
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">From pipeline analytics — top publishers by volume</p>
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Feed</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Total (30d)</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Avg / fetch</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = Math.round((r.total30d / max) * 100);
              return (
                <tr class="border-b border-border last:border-0">
                  <td class="py-2.5 pr-4 text-foreground max-w-0 w-full">
                    <div class="truncate font-medium" title={r.feedId}>{r.title}</div>
                    <div class="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden">
                      <div class="h-full rounded-full bg-primary/50" style={`width:${pct}%`} />
                    </div>
                  </td>
                  <td class="py-2.5 pr-4 text-right font-medium text-primary whitespace-nowrap">+{r.total30d}</td>
                  <td class="py-2.5 text-right text-muted-foreground whitespace-nowrap">{r.avgPerFetch}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function R2FetchPerfCard({ rows }: { rows: R2FetchPerfRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Fetch performance{" "}
          <span class="text-muted-foreground font-normal text-sm">(slowest feeds, last 7 days)</span>
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">Feeds consistently above ~5 s may have slow servers or large payloads</p>
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Feed</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Samples</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Avg</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const avgClass = r.avgMs > 5000
                ? "text-destructive font-medium"
                : r.avgMs > 2000
                  ? "text-yellow-700 font-medium"
                  : "text-muted-foreground";
              return (
                <tr class="border-b border-border last:border-0">
                  <td class="py-2.5 pr-4 font-medium text-foreground truncate max-w-64" title={r.feedId}>
                    {r.title}
                  </td>
                  <td class="py-2.5 pr-4 text-right text-muted-foreground">{r.samples}</td>
                  <td class={`py-2.5 pr-4 text-right ${avgClass}`}>{(r.avgMs / 1000).toFixed(1)} s</td>
                  <td class="py-2.5 text-right text-muted-foreground">{(r.maxMs / 1000).toFixed(1)} s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function R2ErrorRatesCard({ rows }: { rows: R2ErrorRateRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Fetch errors by status{" "}
          <span class="text-muted-foreground font-normal text-sm">(last 7 days)</span>
        </h2>
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Status</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Occurrences</th>
              <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Feeds affected</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const statusClass = r.httpStatus === "429"
                ? "text-orange-700 font-semibold"
                : r.httpStatus.startsWith("4")
                  ? "text-destructive font-semibold"
                  : "text-yellow-700 font-semibold";
              return (
                <tr class="border-b border-border last:border-0">
                  <td class={`py-2.5 pr-4 font-mono ${statusClass}`}>HTTP {r.httpStatus}</td>
                  <td class="py-2.5 pr-4 text-right text-foreground font-medium">{r.occurrences}</td>
                  <td class="py-2.5 text-right text-muted-foreground">{r.affectedFeeds}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function R2ArticleTrendCard({ rows }: { rows: R2ArticleTrendRow[] }) {
  if (rows.length === 0) return null;
  // rows arrive newest-first; reverse for left-to-right display
  const ordered = [...rows].reverse();
  const maxArticles = Math.max(...ordered.map((r) => r.newArticles), 1);
  const total = ordered.reduce((s, r) => s + r.newArticles, 0);
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold text-foreground">
            New articles per day{" "}
            <span class="text-muted-foreground font-normal text-sm">(last 30 days)</span>
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{total.toLocaleString()} articles total</p>
        </div>
      </div>
      <div class="px-6 py-4">
        <div class="flex items-end gap-px h-24 w-full">
          {ordered.map((r) => {
            const pct = Math.max((r.newArticles / maxArticles) * 100, r.newArticles > 0 ? 2 : 0);
            return (
              <div
                class="flex-1 min-w-0 rounded-t bg-primary/70"
                style={`height:${pct}%`}
                title={`${r.day}: ${r.newArticles} articles`}
              />
            );
          })}
        </div>
        <div class="flex justify-between mt-1 text-xs text-muted-foreground">
          <span>{ordered[0]?.day.slice(5) ?? ""}</span>
          <span>→ {ordered[ordered.length - 1]?.day.slice(5) ?? ""}</span>
        </div>
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
      <FeedActivityCard rows={data.feedActivity} />
      <FeedHealthCard rows={data.feedHealth} />
      <PollIntervalDistCard rows={data.intervalDist} />
      <ReadsByDayCard rows={data.readsByDay} />

      {/* R2 SQL analytics section — only rendered when ANALYTICS_ENABLED + token set */}
      {data.analyticsEnabled && (
        data.r2Trend30d.length > 0 || data.r2Velocity.length > 0 || data.r2FetchPerf.length > 0 || data.r2ErrorRates.length > 0
      ) && (
        <>
          <R2SectionHeader>Pipeline analytics (30-day)</R2SectionHeader>
          <R2ArticleTrendCard rows={data.r2Trend30d} />
          <R2VelocityCard rows={data.r2Velocity} />
          <R2FetchPerfCard rows={data.r2FetchPerf} />
          <R2ErrorRatesCard rows={data.r2ErrorRates} />
        </>
      )}
    </div>
  );
}
