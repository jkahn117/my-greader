/** @jsxImportSource react */
import { Link } from "@tanstack/react-router";
import type {
  ReadingDay,
  ReadingResponse,
  ReadingWindowDays,
} from "../../shared/dashboard-api";
import { READING_WINDOWS } from "../../shared/dashboard-api";
import { cn } from "../lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";

/** Coerce the `?days=` search param to a supported window (router validateSearch). */
export function parseReadingSearch(search: Record<string, unknown>): {
  days: ReadingWindowDays;
} {
  const days = Number(search.days);
  return {
    days: (READING_WINDOWS as readonly number[]).includes(days)
      ? (days as ReadingWindowDays)
      : 7,
  };
}

/** Format a YYYY-MM-DD display-timezone date without re-zoning it. */
function formatDate(date: string, opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
    Date.UTC(y, m - 1, d),
  );
}

/** Segmented 7/14/30-day control; links keep the window in the URL so
 *  reloads and back/forward preserve it, and are keyboard-native. */
function WindowControl({ active }: { active: ReadingWindowDays }) {
  return (
    <div
      role="group"
      aria-label="Time window"
      className="inline-flex rounded-md border border-input p-0.5"
    >
      {READING_WINDOWS.map((days) => (
        <Link
          key={days}
          to="/reading"
          search={{ days }}
          aria-current={days === active ? "page" : undefined}
          className={cn(
            "rounded px-3 py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            days === active
              ? "bg-reading text-reading-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {days} days
        </Link>
      ))}
    </div>
  );
}

/** Daily CSS bar chart; each bar carries a text label so the chart is
 *  readable without colour or hover. */
function DailyChart({ daily }: { daily: ReadingDay[] }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  const labelEvery = daily.length > 14 ? 5 : 1;
  return (
    <ol
      aria-label="Items marked read per day"
      className="flex h-44 items-end gap-0.5 sm:gap-1"
    >
      {daily.map((d, i) => {
        const label = `${formatDate(d.date, { weekday: "short", month: "short", day: "numeric" })}: ${d.count} marked read${d.partial ? " (today, partial)" : ""}`;
        const showTick =
          i === daily.length - 1 || (daily.length - 1 - i) % labelEvery === 0;
        return (
          <li
            key={d.date}
            data-testid="reading-day"
            data-date={d.date}
            data-count={d.count}
            title={label}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          >
            <span className="sr-only">{label}</span>
            <span aria-hidden className="text-[10px] text-muted-foreground">
              {d.count > 0 ? d.count : ""}
            </span>
            <div
              aria-hidden
              className={cn(
                "w-full rounded-t-sm bg-reading",
                d.partial && "bg-reading/50",
              )}
              style={{ height: `${(d.count / max) * 100}%` }}
            />
            <span
              aria-hidden
              className="h-4 text-[10px] whitespace-nowrap text-muted-foreground"
            >
              {showTick ? formatDate(d.date, { day: "numeric" }) : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">
          {label}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

export function ReadingPending() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export function ReadingError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          {unauthorized
            ? "You are not authorized to view reading metrics"
            : "Failed to load reading metrics"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {unauthorized
            ? "Sign in through Cloudflare Access to continue."
            : "Try reloading the page."}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Reading — marked-read receipts per day and per Feed for the selected
 * window. Every total, chart, breakdown, and caption derives from the same
 * response, so window and Subscription scope always agree.
 */
export function ReadingPage({ data }: { data: ReadingResponse }) {
  const first = data.daily[0]?.date;
  const last = data.daily[data.daily.length - 1]?.date;
  const range =
    first && last
      ? `${formatDate(first, { month: "short", day: "numeric" })} – ${formatDate(last, { month: "short", day: "numeric" })} (today, partial)`
      : "";
  const scope = `past ${data.days} days in ${data.timezone}, across your ${data.subscriptionCount} subscription${data.subscriptionCount === 1 ? "" : "s"}`;
  const maxFeed = Math.max(1, ...data.byFeed.map((f) => f.count));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reading</h1>
          <p className="text-sm text-muted-foreground">{range}</p>
        </div>
        <WindowControl active={data.days} />
      </div>

      {data.subscriptionCount === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No subscriptions yet —{" "}
            <Link
              to="/feeds"
              className="text-primary underline-offset-4 hover:underline"
            >
              add feeds
            </Link>{" "}
            to see reading metrics.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label="Items marked read"
              value={data.markedRead}
              sub={scope}
            />
            <StatCard
              label="Currently starred"
              value={data.starredCount}
              sub="current state, not limited to this window"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Marked read per day</CardTitle>
              <CardDescription>
                Days in {data.timezone}. Today is partial and shown lighter.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.markedRead === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No items marked read in the past {data.days} days.
                </p>
              ) : (
                <DailyChart daily={data.daily} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Marked read by feed</CardTitle>
              <CardDescription>
                {scope}. Feeds with nothing marked read are omitted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.byFeed.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No feeds have items marked read in this window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-sm"
                    aria-label="Marked read by feed"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Feed</th>
                        <th className="py-2 pr-4 text-right font-medium">
                          Marked read
                        </th>
                        <th className="hidden w-1/3 py-2 font-medium sm:table-cell">
                          <span className="sr-only">Relative volume</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byFeed.map((f) => (
                        <tr key={f.feedId} className="border-b last:border-0">
                          <td className="max-w-56 py-2.5 pr-4">
                            <Link
                              to="/feeds/$feedId"
                              params={{ feedId: f.feedId }}
                              className="font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {f.title ?? f.feedUrl}
                            </Link>
                            {f.deactivated && (
                              <Badge variant="secondary" className="ml-2">
                                Deactivated
                              </Badge>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-right tabular-nums">
                            {f.count}
                          </td>
                          <td className="hidden py-2.5 sm:table-cell">
                            <div
                              aria-hidden
                              className="h-2 rounded-full bg-reading"
                              style={{ width: `${(f.count / maxFeed) * 100}%` }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About these numbers</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Counts are items currently marked read, dated by when the server
              received the mark-read — not when you actually read them, how long
              you spent, or whether you meant to.
            </li>
            <li>
              Readers that work offline sync later, so their reads land on the
              day they synchronize.
            </li>
            <li>
              Marking an item read again moves it to the latest receipt; marking
              it unread removes it until it is marked read again.
            </li>
            <li>
              Unstarred items are deleted {data.retentionDays} days after they
              were fetched, along with their read state, so older reads can
              disappear from these totals.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
