// ---------------------------------------------------------------------------
// Metrics tab — dashboard backed by Workers Analytics Engine
// ---------------------------------------------------------------------------

interface ParseStat {
  feedId: string;
  successes: number;
  failures: number;
  avgDurationMs: number;
  totalArticles: number;
}

interface ReadStat {
  date: string;
  reads: number;
}

interface StatusData {
  parseStats: ParseStat[];
  readsByDay: ReadStat[];
  totalReads7d: number;
  totalParses7d: number;
  totalFailures7d: number;
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
          Feed parse activity <span class="text-muted-foreground font-normal text-sm">(last 7 days)</span>
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
                  Feed ID
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Successes
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Failures
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Avg duration
                </th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">
                  Articles
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class="border-b border-border last:border-0">
                  <td class="py-3 pr-4 font-mono text-xs text-foreground truncate max-w-[160px]">
                    {r.feedId}
                  </td>
                  <td class="py-3 pr-4 text-right text-foreground">{r.successes}</td>
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
          Reads by day <span class="text-muted-foreground font-normal text-sm">(last 7 days)</span>
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
// Unconfigured state — shown when CF_ACCOUNT_ID / CF_API_TOKEN are missing
// ---------------------------------------------------------------------------

export function MetricsUnconfigured() {
  return (
    <div class="rounded-lg border border-border bg-card px-6 py-10 text-center shadow-sm">
      <p class="text-sm font-medium text-foreground">
        Analytics not configured
      </p>
      <p class="mt-1 text-sm text-muted-foreground">
        Set <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">CF_ACCOUNT_ID</code> and{" "}
        <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">CF_API_TOKEN</code> to enable this dashboard.
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
        <StatCard
          label="Reads (7d)"
          value={data.totalReads7d}
        />
        <StatCard
          label="Parses (7d)"
          value={data.totalParses7d}
        />
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

      <ReadsByDayCard rows={data.readsByDay} />
      <ParseStatsCard rows={data.parseStats} />
    </div>
  );
}
