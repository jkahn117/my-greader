// ---------------------------------------------------------------------------
// Metrics tab — dashboard backed by Workers Analytics Engine
// ---------------------------------------------------------------------------

interface ParseStat {
  feedId: string;
  feedName: string;
  successes: number;
  failures: number;
  avgDurationMs: number;
  totalArticles: number;
}

interface ReadStat {
  date: string;
  reads: number;
}

export interface ParseFailure {
  feedId: string;
  feedName: string;
  error: string;
  timestamp: number;
}

export interface CycleStat {
  cycleCount: number;
  avgActiveFeeds: number;
  avgDueFeeds: number;
  avgCheckedFeeds: number;
  avgNewArticles: number;
  avgFailedFeeds: number;
}

interface IntervalDistRow {
  minutes: number;
  count: number;
}

interface StatusData {
  parseStats: ParseStat[];
  parseFailures: ParseFailure[];
  readsByDay: ReadStat[];
  totalReads7d: number;
  totalParses7d: number;
  totalFailures7d: number;
  cycleStat: CycleStat | null;
  intervalDist: IntervalDistRow[];
}

// ---------------------------------------------------------------------------
// Stat card — single KPI tile
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div class="rounded-lg border border-border bg-card px-6 py-5 shadow-sm">
      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p class="mt-1 text-3xl font-semibold text-foreground">{value}</p>
      {sub && <p class="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parse stats table
// ---------------------------------------------------------------------------

function ParseStatsCard({ rows }: { rows: ParseStat[] }) {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Feed parse activity{" "}
          <span class="text-muted-foreground font-normal text-sm">
            (last 7 days)
          </span>
        </h2>
      </div>
      <div class="px-6 py-2">
        {rows.length === 0 ? (
          <p class="py-6 text-center text-sm text-muted-foreground">
            No parse data yet.
          </p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border">
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">
                  Feed
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Successes
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Failures
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Avg parse duration
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Articles
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class="border-b border-border last:border-0">
                  <td
                    class="py-3 pr-4 text-sm text-foreground truncate max-w-50"
                    title={r.feedId}
                  >
                    {r.feedName}
                  </td>
                  <td class="py-3 pr-4 text-right text-foreground">
                    {r.successes}
                  </td>
                  <td class="py-3 pr-4 text-right">
                    <span
                      class={
                        r.failures > 0
                          ? "text-destructive font-medium"
                          : "text-muted-foreground"
                      }
                    >
                      {r.failures}
                    </span>
                  </td>
                  <td class="py-3 pr-4 text-right text-muted-foreground">
                    {Math.round(r.avgDurationMs)}ms
                  </td>
                  <td class="py-3 text-right text-muted-foreground">
                    {r.totalArticles}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reads by day table
// ---------------------------------------------------------------------------

function ReadsByDayCard({ rows }: { rows: ReadStat[] }) {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Reads by day{" "}
          <span class="text-muted-foreground font-normal text-sm">
            (last 7 days)
          </span>
        </h2>
      </div>
      <div class="px-6 py-2">
        {rows.length === 0 ? (
          <p class="py-6 text-center text-sm text-muted-foreground">
            No read data yet.
          </p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border">
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">
                  Date
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Articles read
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class="border-b border-border last:border-0">
                  <td class="py-3 pr-4 text-foreground">{r.date}</td>
                  <td class="py-3 text-right text-foreground">{r.reads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parse failures card
// ---------------------------------------------------------------------------

function ParseFailuresCard({ rows }: { rows: ParseFailure[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="rounded-lg border border-destructive/40 bg-card shadow-sm">
      <div class="border-b border-destructive/40 px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Parse failures{" "}
          <span class="text-muted-foreground font-normal text-sm">
            (last 7 days, most recent first)
          </span>
        </h2>
      </div>
      <div class="px-6 py-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">
                Feed
              </th>
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">
                When
              </th>
              <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">
                Error
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr class="border-b border-border last:border-0">
                <td
                  class="py-3 pr-4 text-foreground truncate max-w-40"
                  title={r.feedId}
                >
                  {r.feedName}
                </td>
                <td class="py-3 pr-4 text-muted-foreground whitespace-nowrap">
                  <time datetime={String(r.timestamp)}>
                    {new Date(r.timestamp).toISOString()}
                  </time>
                </td>
                <td class="py-3 font-mono text-xs text-destructive break-all">
                  {r.error || (
                    <span class="italic text-muted-foreground">no message</span>
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
// Cycle health card — adaptive polling summary
// ---------------------------------------------------------------------------

function CycleHealthCard({ stat }: { stat: CycleStat | null }) {
  if (!stat || stat.cycleCount === 0) {
    return (
      <div class="rounded-lg border border-border bg-card shadow-sm">
        <div class="border-b border-border px-6 py-4">
          <h2 class="text-base font-semibold text-foreground">
            Cycle health{" "}
            <span class="text-muted-foreground font-normal text-sm">
              (last 7 days)
            </span>
          </h2>
        </div>
        <p class="px-6 py-6 text-center text-sm text-muted-foreground">
          No cycle data yet — runs after the first Workflow execution.
        </p>
      </div>
    );
  }

  const fmt = (n: number) => n.toFixed(1);

  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">
          Cycle health{" "}
          <span class="text-muted-foreground font-normal text-sm">
            (last 7 days · {stat.cycleCount} cycles)
          </span>
        </h2>
      </div>
      <div class="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
        {[
          { label: "Avg active feeds", value: fmt(stat.avgActiveFeeds) },
          { label: "Avg due/cycle", value: fmt(stat.avgDueFeeds) },
          { label: "Avg checked/cycle", value: fmt(stat.avgCheckedFeeds) },
          { label: "Avg new articles/cycle", value: fmt(stat.avgNewArticles) },
          { label: "Avg failed/cycle", value: fmt(stat.avgFailedFeeds) },
        ].map(({ label, value }) => (
          <div class="bg-card px-6 py-4">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <p class="mt-1 text-2xl font-semibold text-foreground">{value}</p>
          </div>
        ))}
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
          <span class="text-muted-foreground font-normal text-sm">
            (active feeds)
          </span>
        </h2>
      </div>
      <div class="px-6 py-4 space-y-3">
        {rows.map((r) => {
          const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
          const barClass =
            r.minutes <= 30
              ? "bg-green-500"
              : r.minutes <= 120
                ? "bg-yellow-400"
                : "bg-orange-400";
          return (
            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="text-foreground font-medium">
                  {intervalLabel(r.minutes)}
                </span>
                <span class="text-muted-foreground">
                  {r.count} feed{r.count !== 1 ? "s" : ""} · {pct}%
                </span>
              </div>
              <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  class={`h-full rounded-full ${barClass}`}
                  style={`width:${pct}%`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unconfigured state — shown when CF_ACCOUNT_ID / CF_API_TOKEN are missing
// ---------------------------------------------------------------------------

export function MetricsUnconfigured() {
  return (
    <div class="rounded-lg border border-border bg-card px-6 py-10 text-center shadow-sm">
      <p class="text-sm font-medium text-foreground">
        Analytics not configured
      </p>
      <p class="mt-1 text-sm text-muted-foreground">
        Set{" "}
        <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          CF_ACCOUNT_ID
        </code>{" "}
        and{" "}
        <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          CF_API_TOKEN
        </code>{" "}
        to enable this dashboard.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full Status tab
// ---------------------------------------------------------------------------

export function MetricsTab({ data }: { data: StatusData }) {
  return (
    <div class="space-y-8">
      {/* KPI row */}
      <div class="grid grid-cols-3 gap-4">
        <StatCard label="Reads (7d)" value={data.totalReads7d} />
        <StatCard label="Parses (7d)" value={data.totalParses7d} />
        <StatCard
          label="Parse failures (7d)"
          value={data.totalFailures7d}
          sub={
            data.totalParses7d > 0
              ? `${Math.round((data.totalFailures7d / data.totalParses7d) * 100)}% failure rate`
              : undefined
          }
        />
      </div>

      <CycleHealthCard stat={data.cycleStat} />
      <PollIntervalDistCard rows={data.intervalDist} />
      <ReadsByDayCard rows={data.readsByDay} />
      <ParseStatsCard rows={data.parseStats} />
      <ParseFailuresCard rows={data.parseFailures} />
    </div>
  );
}
