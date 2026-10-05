/** @jsxImportSource react */
import { useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import type {
  FeedAttemptsResponse,
  FeedDetailResponse,
} from "../../shared/dashboard-api";
import { ApiError, apiPost } from "../lib/api";
import { cn } from "../lib/utils";
import {
  CheckHistory,
  ErrorBreakdown,
  Results,
  useFeedAttempts,
} from "../components/attempt-history";
import { formatDateTime, formatInterval } from "../lib/time";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
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

type Tone = "warning" | "destructive" | "neutral";

interface ProblemSummary {
  tone: Tone;
  headline: string;
  detail: string;
}

/** "the last check" / "the last 3 checks" / "at least the last 500 checks". */
function lastChecks(n: number, lowerBound: boolean): string {
  if (n <= 1 && !lowerBound) return "the last check";
  return `${lowerBound ? "at least " : ""}the last ${n} checks`;
}

/**
 * Plain-language summary of the Feed's current state built only from
 * recorded fields: persisted health (status, Deactivation reason, error
 * counter) plus check-based streaks once attempt history has loaded.
 */
function problemSummary(
  detail: FeedDetailResponse,
  history: FeedAttemptsResponse | null,
): ProblemSummary {
  const lastSuccess =
    detail.lastSuccessfulAt != null
      ? `Last successful check ${formatDateTime(detail.lastSuccessfulAt)}.`
      : "No successful check recorded.";
  const lastError = detail.lastError ? `Last error: ${detail.lastError}. ` : "";

  if (detail.deactivatedAt != null) {
    const when = formatDateTime(detail.deactivatedAt);
    switch (detail.deactivatedReason) {
      case "manual":
        return {
          tone: "neutral",
          headline: "Polling is paused manually.",
          detail: `Manual Deactivation ${when}. No checks run until the Feed is reactivated. ${lastSuccess}`,
        };
      case "transient":
        return {
          tone: "destructive",
          headline:
            "Automatically deactivated after repeated transient errors.",
          detail: `Automatic Deactivation ${when}. ${lastError}${lastSuccess}`,
        };
      case "permanent":
        return {
          tone: "destructive",
          headline: "Automatically deactivated after a permanent failure.",
          detail: `Automatic Deactivation ${when}. ${lastError}${lastSuccess}`,
        };
      default:
        return {
          tone: "warning",
          headline:
            "Deactivated before Deactivation reasons were recorded — the cause is unknown.",
          detail: `Deactivated ${when}. ${lastSuccess}`,
        };
    }
  }

  if (detail.status === "rate_limited") {
    const streak = history?.streaks.rateLimited;
    const lead = `HTTP 429 on ${lastChecks(streak?.count ?? 1, streak?.lowerBound ?? false)}.`;
    return {
      tone: "warning",
      headline: `${lead} Backoff is active.`,
      detail: `The server requested less frequent polling. Rate limiting does not count toward automatic Deactivation. ${lastSuccess}`,
    };
  }

  if (detail.status === "failing") {
    const streak = history?.streaks.problem;
    const latestFailure = history?.attempts.find((a) => a.status === "error");
    const cause =
      latestFailure?.errorMessage ?? detail.lastError ?? "Failed checks";
    // Prefer check-based streaks; fall back to the persisted counter while
    // history loads or when no attempts are retained.
    const count = streak?.count || detail.consecutiveErrors || 1;
    const headline = `${cause} on ${lastChecks(count, streak?.lowerBound ?? false)}.`;
    return {
      tone: "destructive",
      headline,
      detail: `${detail.consecutiveErrors > 0 ? `${detail.consecutiveErrors} consecutive errors count toward automatic Deactivation. ` : ""}${lastSuccess}`,
    };
  }

  if (detail.status === "new") {
    return {
      tone: "neutral",
      headline: "Not successfully checked yet.",
      detail: `Backload is pending until the first successful check. ${lastError}`,
    };
  }

  return {
    tone: "neutral",
    headline: "No current problem. The latest check succeeded.",
    detail: `${lastSuccess} Last new item ${detail.lastNewItemAt != null ? formatDateTime(detail.lastNewItemAt) : "never recorded"}.`,
  };
}

const TONE_CLASS: Record<Tone, string> = {
  warning: "border-warning/60",
  destructive: "border-destructive/50",
  neutral: "",
};

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
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

/**
 * Full-page Feed diagnostic (design rev05): current state (summary, Backoff,
 * eligibility, backload) above historical attempt evidence (check strip,
 * grouped errors, expandable results).
 */
export function FeedDetailPage({ data }: { data: FeedDetailResponse }) {
  const router = useRouter();
  const [detail, setDetail] = useState(data);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const attempts = useFeedAttempts(detail.feedId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const deactivated = detail.deactivatedAt != null;
  const summary = problemSummary(detail, attempts.data);

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
    } catch (err) {
      setNotice(
        `${action === "deactivate" ? "Deactivation" : "Reactivation"} failed` +
          `${err instanceof ApiError ? ` (${err.status})` : ""}.`,
      );
    } finally {
      setBusy(false);
      actionRef.current?.focus();
    }
  }

  function setOpen(id: string, open: boolean) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectCheck(id: string) {
    setSelectedId(id);
    setOpen(id, true);
    requestAnimationFrame(() =>
      document
        .getElementById(`attempt-${id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }

  const nextEligible = deactivated
    ? { value: "Not eligible", sub: "Deactivated — reactivate to resume" }
    : detail.nextCheckAt != null
      ? { value: formatDateTime(detail.nextCheckAt) }
      : { value: "Next polling cycle", sub: "Never checked" };

  return (
    <div className="space-y-5">
      <Link
        to="/feeds"
        className="inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Feeds
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight break-words sm:text-3xl">
              {detail.title ?? detail.feedUrl}
            </h1>
            <StatusBadge status={detail.status} />
          </div>
          <p className="text-sm break-all text-muted-foreground">
            {detail.feedUrl}
            {detail.folder ? ` · Folder: ${detail.folder}` : " · No folder"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={actionRef} variant="outline" disabled={busy}>
              Feed actions
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {deactivated ? (
              <DropdownMenuItem onSelect={() => void runAction("reactivate")}>
                Reactivate feed
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => void runAction("deactivate")}
              >
                Deactivate feed
              </DropdownMenuItem>
            )}
            {detail.htmlUrl && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={detail.htmlUrl} target="_blank" rel="noreferrer">
                    Open website
                  </a>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <section aria-label="Current state" className="space-y-4">
        <Card className={cn("gap-1 py-4", TONE_CLASS[summary.tone])}>
          <CardContent>
            <p className="text-sm font-semibold">{summary.headline}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.detail}
            </p>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label="Current backoff"
                value={formatInterval(detail.checkIntervalMinutes)}
                sub="Interval between checks"
              />
              <Stat label="Next eligible" {...nextEligible} />
              <Stat
                label="Last new item"
                value={
                  detail.lastNewItemAt != null
                    ? formatDateTime(detail.lastNewItemAt)
                    : "Never"
                }
              />
              <Stat
                label="Backload"
                value={detail.backloadComplete ? "Complete" : "Pending"}
                sub={
                  detail.backloadComplete
                    ? undefined
                    : "No successful check yet"
                }
              />
            </dl>
          </CardContent>
        </Card>
      </section>

      <section
        aria-label="Attempt history"
        className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      >
        <CheckHistory
          state={attempts}
          selectedId={selectedId}
          onSelect={selectCheck}
        />
        <ErrorBreakdown state={attempts} />
      </section>

      <Results state={attempts} openIds={openIds} onOpenChange={setOpen} />
    </div>
  );
}
