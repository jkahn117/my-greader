/** @jsxImportSource react */
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
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
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
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

const readingChartConfig = {
  count: { label: "Marked read", color: "var(--color-reading)" },
} satisfies ChartConfig;

/**
 * Violet shadcn/recharts bar chart of marked-read receipts per day. The
 * current (partial) day renders lighter; a <details> table exposes the same
 * values without requiring the chart, colour, or hover.
 */
function DailyChart({
  daily,
  timezone,
}: {
  daily: ReadingDay[];
  timezone: string;
}) {
  const weekly = daily.length <= 8;
  const data = daily.map((d) => ({
    ...d,
    tick: formatDate(
      d.date,
      weekly ? { weekday: "short" } : { month: "short", day: "numeric" },
    ),
  }));
  return (
    <div>
      <ChartContainer
        config={readingChartConfig}
        className="h-48 w-full"
        role="img"
        aria-label={`Items marked read per day for the last ${daily.length} days (${timezone})`}
      >
        <BarChart data={data} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="tick"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
            interval={daily.length <= 14 ? 0 : "preserveStartEnd"}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            fontSize={11}
            allowDecimals={false}
            width={28}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const row = (
                    payload as { payload?: ReadingDay }[] | undefined
                  )?.[0]?.payload;
                  return row?.date
                    ? `${formatDate(row.date, { weekday: "short", month: "short", day: "numeric" })}${row.partial ? " · today (partial)" : ""}`
                    : "";
                }}
                formatter={(value) => (
                  <div className="flex w-full items-center justify-between gap-4">
                    <span className="text-muted-foreground">Marked read</span>
                    <span className="font-mono font-medium tabular-nums">
                      {Number(value)}
                    </span>
                  </div>
                )}
              />
            }
          />
          <Bar
            dataKey="count"
            fill="var(--color-count)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell key={d.date} fillOpacity={d.partial ? 0.45 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <details className="mt-3 text-sm">
        <summary className="w-fit cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          Daily totals
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table
            className="w-full text-sm"
            aria-label="Items marked read per day"
          >
            <tbody>
              {daily.map((d) => (
                <tr
                  key={d.date}
                  data-testid="reading-day"
                  data-date={d.date}
                  data-count={d.count}
                  className="border-b last:border-0"
                >
                  <th
                    scope="row"
                    className="py-1.5 pr-4 text-left font-normal text-muted-foreground"
                  >
                    {formatDate(d.date, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                    {d.partial ? " (today, partial)" : ""}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Skeleton shown while the reading loader is in flight. */
export function ReadingPending() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}

/** Safe failure / unavailable / unauthorized state for the reading route. */
export function ReadingError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  const unavailable = status === 503;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          {unauthorized
            ? "You are not authorized to view reading metrics"
            : unavailable
              ? "Reading metrics unavailable"
              : "Failed to load reading metrics"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {unauthorized
            ? "Sign in through Cloudflare Access to continue."
            : unavailable
              ? "The database is unavailable right now — try again shortly."
              : "Try reloading the page."}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Reading — revision 05 panel: marked-read metric + violet daily chart in
 * one column, starred metric + per-Feed breakdown in the other, with honest
 * captions below. Every total, chart, breakdown, and caption derives from
 * the same response, so window and Subscription scope always agree.
 */
export function ReadingPage({ data }: { data: ReadingResponse }) {
  const first = data.daily[0]?.date;
  const last = data.daily[data.daily.length - 1]?.date;
  const range =
    first && last
      ? `${formatDate(first, { month: "short", day: "numeric" })} – ${formatDate(last, { month: "short", day: "numeric" })}`
      : "";
  const scope = `past ${data.days} days in ${data.timezone}, across your ${data.subscriptionCount} subscription${data.subscriptionCount === 1 ? "" : "s"}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reading
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            Reading activity
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Client-reported state, not inferred reading completion
            {range ? ` · ${range} (${data.timezone})` : ""}
          </p>
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
          {/* min-w-0 lets the cards shrink below the chart's aspect-ratio
              min-content width on narrow viewports */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Items marked read · last {data.days} days
                </CardDescription>
                <CardTitle className="text-3xl font-semibold">
                  {data.markedRead}
                </CardTitle>
                <CardDescription>{scope}</CardDescription>
              </CardHeader>
              <CardContent>
                {data.markedRead === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No items marked read in the past {data.days} days.
                  </p>
                ) : (
                  <DailyChart daily={data.daily} timezone={data.timezone} />
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Currently starred
                </CardDescription>
                <CardTitle className="text-3xl font-semibold">
                  {data.starredCount}
                </CardTitle>
                <CardDescription>
                  Current state — not limited to this window.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <h2 className="text-sm font-semibold">
                  Marked read by Feed · {data.days} days
                </h2>
                {data.byFeed.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No feeds have items marked read in this window.
                  </p>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table
                      className="w-full text-sm"
                      aria-label="Marked read by feed"
                    >
                      <tbody>
                        {data.byFeed.map((f) => (
                          <tr key={f.feedId} className="border-b last:border-0">
                            <td className="max-w-56 py-2 pr-4">
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
                            <td className="py-2 text-right font-medium text-reading tabular-nums">
                              {f.count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">About these numbers</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>
                  Counts are items currently marked read, dated by when the
                  server received the mark-read — not when you actually read
                  them, how long you spent, or whether you meant to.
                </li>
                <li>
                  Readers that work offline sync later, so their reads land on
                  the day they synchronize.
                </li>
                <li>
                  Marking an item read again moves it to the latest receipt;
                  marking it unread removes it until it is marked read again.
                </li>
                <li>
                  Unstarred items are deleted {data.retentionDays} days after
                  they were fetched, along with their read state, so older reads
                  can disappear from these totals.
                </li>
                <li>
                  No release / expiration breakdown until the Current experiment
                  in{" "}
                  <a
                    href="https://github.com/jkahn117/my-greader/issues/41"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    issue #41
                  </a>
                  .
                </li>
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
