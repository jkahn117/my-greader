/** @jsxImportSource react */
import { useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import type { FeedDetailResponse } from "../../shared/dashboard-api";
import { ApiError, apiPost } from "../lib/api";
import { AttemptHistory } from "../components/attempt-history";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";

function StatusBadge({ status }: { status: FeedDetailResponse["status"] }) {
  switch (status) {
    case "deactivated":
      return <Badge variant="secondary">Deactivated</Badge>;
    case "rate_limited":
      return <Badge variant="warning">Rate limited</Badge>;
    case "failing":
      return <Badge variant="destructive">Failing</Badge>;
    case "new":
      return <Badge variant="outline">New</Badge>;
    default:
      return <Badge variant="default">Active</Badge>;
  }
}

function deactivationLabel(detail: FeedDetailResponse): string {
  switch (detail.deactivatedReason) {
    case "transient":
      return "Automatic — repeated transient errors";
    case "permanent":
      return "Automatic — permanent failure";
    case "manual":
      return "Manual";
    default:
      return "Unknown — deactivated before reason tracking existed";
  }
}

export function FeedDetailPending() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-5 w-40" />
      <Card>
        <CardContent className="space-y-3 py-6">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function FeedDetailError({ status }: { status?: number }) {
  const missing = status === 404;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium">
          {missing ? "Feed not found" : "Failed to load feed"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {missing
            ? "This feed isn't in your subscriptions."
            : "The feed detail could not be loaded."}
        </p>
        <Link
          to="/feeds"
          className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
        >
          Back to feeds
        </Link>
      </CardContent>
    </Card>
  );
}

export function FeedDetailPage({ data }: { data: FeedDetailResponse }) {
  const router = useRouter();
  const [detail, setDetail] = useState(data);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);

  const deactivated = detail.deactivatedAt != null;

  async function runAction(action: "deactivate" | "reactivate") {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiPost<FeedDetailResponse>(
        `/app/api/feeds/${detail.feedId}/${action}`,
      );
      setDetail(res);
      setNotice(`Feed ${action}d.`);
      router.invalidate();
      // return focus to the action control after the state swap
      actionRef.current?.focus();
    } catch (err) {
      setNotice(
        `${action === "deactivate" ? "Deactivation" : "Reactivation"} failed` +
          `${err instanceof ApiError ? ` (${err.status})` : ""}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<[string, React.ReactNode]> = [
    ["Status", <StatusBadge key="s" status={detail.status} />],
    ["Last successful check", formatTime(detail.lastSuccessfulAt)],
    ["Last check attempt", formatTime(detail.lastCheckedAt)],
    ["Last new item", formatTime(detail.lastNewItemAt)],
    [
      "Next check",
      deactivated
        ? "Not eligible (deactivated)"
        : formatTime(detail.nextCheckAt),
    ],
    [
      "Backoff",
      `every ${detail.checkIntervalMinutes} minutes` +
        (detail.status === "rate_limited" ? " (rate limited)" : ""),
    ],
    ["Consecutive errors", String(detail.consecutiveErrors)],
    [
      "Backload",
      detail.backloadComplete
        ? "Complete — the feed has been checked successfully"
        : "Pending — no successful check yet",
    ],
  ];
  if (deactivated) {
    rows.push([
      "Deactivation",
      `${deactivationLabel(detail)} (${formatTime(detail.deactivatedAt)})`,
    ]);
  }
  if (detail.lastError && detail.status !== "active") {
    rows.push(["Last error", detail.lastError]);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/feeds"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Feeds
        </Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">
            {detail.title ?? detail.feedUrl}
          </h1>
          <StatusBadge status={detail.status} />
        </div>
        <Button
          ref={actionRef}
          size="sm"
          variant={deactivated ? "default" : "destructive"}
          disabled={busy}
          onClick={() => runAction(deactivated ? "reactivate" : "deactivate")}
        >
          {deactivated ? "Reactivate" : "Deactivate"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {detail.feedUrl}
        {detail.folder && <span> · {detail.folder}</span>}
        {detail.htmlUrl && (
          <>
            {" "}
            ·{" "}
            <a
              href={detail.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              site
            </a>
          </>
        )}
      </p>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current state</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <AttemptHistory feedId={detail.feedId} />
    </div>
  );
}
