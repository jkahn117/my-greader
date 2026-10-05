/** @jsxImportSource react */
import type { OverviewResponse } from "../../shared/dashboard-api";
import { OverviewPanels } from "../components/overview-panels";
import { SyncButton } from "../components/sync-button";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";

/** Page subtitle line describing the latest polling-cycle lifecycle. */
function cycleSubtitle(cycle: OverviewResponse["latestCycle"]): string {
  switch (cycle.state) {
    case "running":
      return "A polling cycle is running now.";
    case "completed":
      return `Latest completed polling activity was ${formatTime(cycle.ranAt)}.`;
    case "empty":
      return `Latest polling activity checked nothing ${formatTime(cycle.ranAt)}.`;
    case "unknown":
      return `Latest recorded polling activity was ${formatTime(cycle.ranAt)}.`;
    default:
      return "No polling activity recorded yet.";
  }
}

/** Sub-line for the attention card: kind breakdown or all-clear. */
function attentionSubtitle(a: OverviewResponse["attention"]): string {
  const parts: string[] = [];
  if (a.rateLimited > 0) parts.push(`${a.rateLimited} rate limited`);
  if (a.failing > 0) parts.push(`${a.failing} failing`);
  if (a.autoDeactivated > 0)
    parts.push(`${a.autoDeactivated} auto-deactivated`);
  if (a.manuallyPaused > 0) parts.push(`${a.manuallyPaused} manually paused`);
  return parts.length > 0 ? parts.join(" · ") : "All feeds healthy";
}

/** Summary stat tile in the required Overview order. */
function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardDescription className="text-[13px]">{label}</CardDescription>
        <CardTitle className="text-3xl font-semibold">{value}</CardTitle>
      </CardHeader>
      {sub && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{sub}</p>
        </CardContent>
      )}
    </Card>
  );
}

/** Skeleton shown while the overview loader is in flight. */
export function OverviewPending() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}

/** Safe failure / unauthorized state for the overview route. */
export function OverviewError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          {unauthorized
            ? "You are not authorized to view the dashboard"
            : "Failed to load overview"}
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
 * Overview — "Your deployment at a glance": summary totals in the spec order
 * (Feeds, New Items 7d, Items marked read 7d, Feeds needing attention), then
 * reading + feed health panels, then the compact Needs attention list.
 */
export function OverviewPage({ data }: { data: OverviewResponse }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Overview
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            Your deployment at a glance
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Reading activity and Feed health. {cycleSubtitle(data.latestCycle)}
          </p>
        </div>
        <SyncButton />
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="Your Feeds"
          value={data.feedCount}
          sub={`${data.activeFeedCount} active · ${data.deactivatedFeedCount} deactivated`}
        />
        <StatCard
          label="New Items · 7 days"
          value={data.newItemsLast7Days}
          sub="In your Subscriptions"
        />
        <StatCard
          label="Items marked read · 7 days"
          value={data.markedReadLast7Days}
          sub="Client-reported read state"
        />
        <StatCard
          label="Feeds needing attention"
          value={data.attention.total}
          sub={attentionSubtitle(data.attention)}
        />
      </div>

      <OverviewPanels timezone={data.timezone} feedCount={data.feedCount} />
    </div>
  );
}
