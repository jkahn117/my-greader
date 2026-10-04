/** @jsxImportSource react */
import type { OverviewResponse } from "../../shared/dashboard-api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";

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
      <CardHeader className="pb-0">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">
          {label}
        </CardDescription>
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

/** Skeleton grid shown while the overview loader is in flight. */
export function OverviewPending() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
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
 * Overview — summary totals in the spec order:
 * Feed count, New Items (7d), Items marked read (7d), Feeds needing attention.
 */
export function OverviewPage({ data }: { data: OverviewResponse }) {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Feeds"
          value={data.feedCount}
          sub={`${data.activeFeedCount} active · ${data.deactivatedFeedCount} deactivated`}
        />
        <StatCard
          label="New items"
          value={data.newItemsLast7Days}
          sub="past 7 days, across your feeds"
        />
        <StatCard
          label="Items marked read"
          value={data.markedReadLast7Days}
          sub="past 7 days, as reported by your reader"
        />
        <StatCard
          label="Needs attention"
          value={data.feedsNeedingAttention}
          sub="deactivated or erroring feeds"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Marked-read counts reflect reader-reported state receipts, not verified
        reading time. Times shown in {data.timezone}.
      </p>
    </div>
  );
}
