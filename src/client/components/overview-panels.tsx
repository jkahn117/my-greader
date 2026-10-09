/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChevronRight } from "lucide-react";
import type {
  AttentionFeed,
  OverviewPanelsResponse,
} from "../../shared/dashboard-api";
import { apiGet } from "../lib/api";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import { Badge } from "../components/ui/badge";

const readingChartConfig = {
  count: { label: "Marked read", color: "var(--color-reading)" },
} satisfies ChartConfig;

/** Weekday label for a display-timezone YYYY-MM-DD day key. */
function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

/** Violet shadcn/recharts bar chart with an sr-only tabular alternative. */
function ReadingChart({
  daily,
  windowDays,
  timezone,
}: {
  daily: { date: string; count: number }[];
  windowDays: number;
  timezone: string;
}) {
  const data = daily.map((d) => ({ day: dayLabel(d.date), ...d }));
  return (
    <div>
      <ChartContainer
        config={readingChartConfig}
        className="h-36 w-full"
        role="img"
        aria-label={`Items marked read per day for the last ${windowDays} days (${timezone})`}
      >
        <BarChart data={data} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            domain={[0, (max: number) => Math.max(1, max)]}
            tickCount={3}
            width={28}
            fontSize={12}
          />
          <ChartTooltip
            content={<ChartTooltipContent labelKey="date" />}
            cursor={false}
          />
          <Bar
            dataKey="count"
            fill="var(--color-count)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Items marked read per day</caption>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{d.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted-foreground">
        Items marked read · last {windowDays} days ({timezone}; boundary days
        are partial)
      </p>
    </div>
  );
}

function cycleLabel(cycle: OverviewPanelsResponse["cycle"]): string {
  switch (cycle.state) {
    case "unknown":
      return "Last recorded cycle has no lifecycle information";
    case "running":
      return "A polling cycle is running now";
    case "completed":
      return `Last cycle completed ${formatTime(cycle.ranAt)} — ${cycle.checkedFeeds} feeds checked`;
    case "empty":
      return `Last cycle ${formatTime(cycle.ranAt)} checked nothing`;
    default:
      return "No polling cycles recorded yet";
  }
}

const ATTENTION_PILL: Record<
  AttentionFeed["kind"],
  { label: string; variant: "warning" | "destructive" }
> = {
  rate_limited: { label: "Rate limited", variant: "warning" },
  failing: { label: "Failing", variant: "destructive" },
  auto_deactivated: { label: "Auto-deactivated", variant: "destructive" },
};

export function OverviewPanels({
  timezone,
  feedCount,
}: {
  timezone: string;
  feedCount: number;
}) {
  const [data, setData] = useState<OverviewPanelsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<OverviewPanelsResponse>("/app/api/overview/panels")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <p className="text-sm text-muted-foreground">
        Overview panels could not be loaded — the summary above is still
        accurate.
      </p>
    );
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading panels…</p>;
  }

  const healthRows: [string, number, string?][] = [
    ["Unchanged / not modified", data.feedHealth.empty],
    ["New Items", data.feedHealth.successful, "text-primary"],
    ["Rate limited", data.feedHealth.rateLimited, "text-warning-foreground"],
    ["Failed", data.feedHealth.failed, "text-destructive"],
    ["Skipped (deliberate)", data.feedHealth.skipped],
    ["Check running", data.feedHealth.running],
    ["No recorded activity", data.feedHealth.missing],
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
            <CardTitle>Your reading activity</CardTitle>
            <Link
              to="/reading"
              search={{ days: 7 }}
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Reading detail →
            </Link>
          </CardHeader>
          <CardContent className="space-y-4">
            <ReadingChart
              daily={data.reading.daily}
              windowDays={data.reading.windowDays}
              timezone={timezone}
            />
            {data.reading.topFeeds.length > 0 ? (
              <div>
                <ul className="space-y-1 text-sm">
                  {data.reading.topFeeds.slice(0, 3).map((f) => (
                    <li key={f.feedId} className="flex justify-between gap-4">
                      <Link
                        to="/feeds/$feedId"
                        params={{ feedId: f.feedId }}
                        className="truncate text-primary underline-offset-4 hover:underline"
                      >
                        {f.title ?? f.feedId}
                      </Link>
                      <span className="shrink-0 text-muted-foreground">
                        {f.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing marked read in this window.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Dates reflect latest server receipt. Read state does not
              distinguish reading from release.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Feed health</CardTitle>
            <p className="text-xs text-muted-foreground">
              Latest check per subscribed Feed
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              aria-hidden="true"
              className="flex h-3.5 overflow-hidden rounded-sm bg-muted"
            >
              {[
                [data.feedHealth.empty, "bg-[#bac5df]"],
                [data.feedHealth.successful, "bg-primary"],
                [data.feedHealth.rateLimited, "bg-warning"],
                [data.feedHealth.failed, "bg-destructive"],
              ].map(([count, color]) =>
                Number(count) > 0 ? (
                  <div
                    key={color}
                    className={String(color)}
                    style={{ flexGrow: Number(count) }}
                  />
                ) : null,
              )}
            </div>
            <ul className="space-y-1.5 text-sm">
              {healthRows.map(([label, count, tone]) => (
                <li key={label} className="flex justify-between gap-4">
                  <span className={tone ?? "text-muted-foreground"}>
                    {label}
                  </span>
                  <span className={`font-medium tabular-nums ${tone ?? ""}`}>
                    {count}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {cycleLabel(data.cycle)}
            </p>
            <div className="border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                30-day ingest (Analytics Engine)
              </p>
              {data.analyticsEngine.status === "ok" &&
              data.analyticsEngine.trend30d.length > 0 ? (
                <div className="mt-2 flex h-12 items-end gap-0.5" aria-hidden>
                  {data.analyticsEngine.trend30d
                    .slice()
                    .reverse()
                    .map((d) => {
                      const max = Math.max(
                        1,
                        ...(data.analyticsEngine.status === "ok"
                          ? data.analyticsEngine.trend30d.map(
                              (t) => t.newArticles,
                            )
                          : [1]),
                      );
                      return (
                        <div
                          key={d.day}
                          title={`${d.day}: ${d.newArticles}`}
                          className="flex-1 rounded-t bg-primary/70"
                          style={{
                            height: `${Math.max(4, (d.newArticles / max) * 100)}%`,
                          }}
                        />
                      );
                    })}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Analytics Engine data unavailable — core panels above are
                  unaffected.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
          <CardTitle>Needs attention</CardTitle>
          <Link
            to="/feeds"
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            All {feedCount} Feeds →
          </Link>
        </CardHeader>
        <CardContent>
          {data.needsAttention.length === 0 && data.manuallyPaused === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing needs attention right now.
            </p>
          ) : (
            <>
              {data.needsAttention.length > 0 && (
                <ul className="divide-y">
                  {data.needsAttention.map((f) => {
                    const pill = ATTENTION_PILL[f.kind];
                    return (
                      <li key={f.feedId}>
                        <Link
                          to="/feeds/$feedId"
                          params={{ feedId: f.feedId }}
                          className="group flex items-center gap-4 py-3"
                        >
                          <span className="w-40 shrink-0 truncate text-sm font-semibold">
                            {f.title ?? f.feedId}
                          </span>
                          <Badge variant={pill.variant} className="shrink-0">
                            {pill.label}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                            {f.detail}
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              {data.manuallyPaused > 0 && (
                <p className="pt-3 text-xs text-muted-foreground">
                  {data.manuallyPaused} additional Feed
                  {data.manuallyPaused === 1 ? " is" : "s are"} manually paused,
                  not counted as a failure.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
