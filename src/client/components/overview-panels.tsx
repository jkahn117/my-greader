/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { OverviewPanelsResponse } from "../../shared/dashboard-api";
import { apiGet } from "../lib/api";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";

/** CSS bar chart of the marked-read trend (violet = reading). */
function ReadingChart({
  daily,
  windowDays,
  timezone,
}: {
  daily: { date: string; count: number }[];
  windowDays: number;
  timezone: string;
}) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div>
      <div className="flex h-24 items-end gap-1.5" aria-hidden>
        {daily.map((d) => (
          <div
            key={d.date}
            title={`${d.date}: ${d.count} marked read`}
            className="flex-1 rounded-t bg-violet-500/80"
            style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Items marked read per day ({windowDays} days, {timezone}; boundary days
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

export function OverviewPanels({ timezone }: { timezone: string }) {
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

  const healthRows: [string, number][] = [
    ["New items on last check", data.feedHealth.successful],
    ["Completed, nothing new", data.feedHealth.empty],
    ["Rate limited", data.feedHealth.rateLimited],
    ["Failed", data.feedHealth.failed],
    ["Skipped (deliberate)", data.feedHealth.skipped],
    ["Check running", data.feedHealth.running],
    ["No recorded activity", data.feedHealth.missing],
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reading activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ReadingChart
              daily={data.reading.daily}
              windowDays={data.reading.windowDays}
              timezone={timezone}
            />
            {data.reading.topFeeds.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Most marked read
                </p>
                <ul className="mt-1 space-y-1 text-sm">
                  {data.reading.topFeeds.map((f) => (
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Feed health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {healthRows.map(([label, count]) => (
                <li key={label} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium">{count}</span>
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
                          className="flex-1 rounded-t bg-blue-500/70"
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
        <CardHeader>
          <CardTitle className="text-base">Needs attention</CardTitle>
        </CardHeader>
        <CardContent>
          {data.needsAttention.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing needs attention right now.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {data.needsAttention.map((f) => (
                <li
                  key={f.feedId}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <Link
                    to="/feeds/$feedId"
                    params={{ feedId: f.feedId }}
                    className="truncate text-primary underline-offset-4 hover:underline"
                  >
                    {f.title ?? f.feedId}
                  </Link>
                  <Badge variant="secondary" className="shrink-0">
                    {f.reason}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
