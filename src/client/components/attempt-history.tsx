/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type {
  FeedAttempt,
  FeedAttemptsResponse,
} from "../../shared/dashboard-api";
import { apiGet } from "../lib/api";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

function attemptLabel(a: FeedAttempt): string {
  if (a.status === "ok") return a.itemsAdded ? "New items" : "Unchanged";
  if (a.status === "not_modified") return "Not modified";
  if (a.status === "rate_limited") return "Rate limited";
  if (a.status === "error") return "Failed";
  if (a.status === "skipped") return "Skipped";
  return "In progress";
}

function attemptBadgeVariant(
  a: FeedAttempt,
): "default" | "secondary" | "destructive" | "outline" | "warning" {
  if (a.status === "ok") return a.itemsAdded ? "default" : "secondary";
  if (a.status === "not_modified") return "secondary";
  if (a.status === "rate_limited") return "warning";
  if (a.status === "error") return "destructive";
  return "outline";
}

// Outcome strip colors — blue for ingestion, amber warning, red failure,
// neutral for ordinary checks/skips.
function tickClass(a: FeedAttempt): string {
  if (a.status === "ok")
    return a.itemsAdded ? "bg-blue-500" : "bg-muted-foreground/40";
  if (a.status === "not_modified") return "bg-muted-foreground/40";
  if (a.status === "rate_limited") return "bg-amber-500";
  if (a.status === "error") return "bg-red-500";
  if (a.status === "skipped") return "bg-muted-foreground/20";
  return "bg-blue-300 animate-pulse";
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 px-2 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : "Copy ID"}
    </Button>
  );
}

function AttemptRow({ attempt }: { attempt: FeedAttempt }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-1 py-2 text-left text-sm hover:bg-muted/50"
      >
        <span className="w-24 shrink-0 text-muted-foreground">
          {formatTime(attempt.startedAt)}
        </span>
        <Badge variant={attemptBadgeVariant(attempt)}>
          {attemptLabel(attempt)}
        </Badge>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {attempt.itemsAdded ? `+${attempt.itemsAdded} items` : ""}
          {attempt.durationMs != null ? ` ${attempt.durationMs}ms` : ""}
        </span>
      </button>
      {open && (
        <dl className="grid gap-x-8 gap-y-1.5 px-1 pb-3 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">HTTP status</dt>
            <dd>{attempt.httpStatus ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Parser</dt>
            <dd>{attempt.parserState ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Problem kind</dt>
            <dd>{attempt.errorKind ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Cycle run</dt>
            <dd className="truncate font-mono">{attempt.cycleRunId ?? "—"}</dd>
          </div>
          {attempt.errorMessage && (
            <div className="flex justify-between gap-4 sm:col-span-2">
              <dt className="text-muted-foreground">Error</dt>
              <dd className="text-right">{attempt.errorMessage}</dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-4 sm:col-span-2">
            <dt className="text-muted-foreground">Attempt</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono" title={attempt.id}>
                {attempt.id.slice(0, 8)}…
              </span>
              <CopyButton value={attempt.id} />
            </dd>
          </div>
          {attempt.items.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Items stored</dt>
              <dd>
                <ul className="mt-1 space-y-0.5">
                  {attempt.items.map((it) => (
                    <li key={it.id} className="truncate">
                      {it.url ? (
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {it.title ?? it.url}
                        </a>
                      ) : (
                        (it.title ?? it.id)
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      )}
    </li>
  );
}

export function AttemptHistory({ feedId }: { feedId: string }) {
  const [data, setData] = useState<FeedAttemptsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<FeedAttemptsResponse>(`/app/api/feeds/${feedId}/attempts`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [feedId]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await apiGet<FeedAttemptsResponse>(
        `/app/api/feeds/${feedId}/attempts?cursor=${encodeURIComponent(data.nextCursor)}`,
      );
      setData({
        ...res,
        attempts: [...data.attempts, ...res.attempts],
      });
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attempt history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-muted-foreground">
            Attempt history could not be loaded.
          </p>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {data && (
          <>
            {data.historyState === "legacy" && (
              <p className="text-sm text-muted-foreground">
                This feed was checked before attempt history was recorded —
                earlier checks aren't shown.
              </p>
            )}
            {data.historyState === "empty" && (
              <p className="text-sm text-muted-foreground">
                No checks recorded yet.
              </p>
            )}
            {data.attempts.length > 0 && (
              <div
                aria-label="Attempt outcome timeline"
                className="flex flex-wrap gap-1"
              >
                {data.attempts.map((a) => (
                  <span
                    key={a.id}
                    title={`${attemptLabel(a)} — ${formatTime(a.startedAt)}`}
                    className={`h-3 w-3 rounded-sm ${tickClass(a)}`}
                  />
                ))}
              </div>
            )}
            {(data.streaks.problem.count > 0 ||
              data.streaks.rateLimited.count > 0) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {data.streaks.problem.count > 0 && (
                  <Badge variant="destructive">
                    Problem streak: {data.streaks.problem.lowerBound ? "≥" : ""}
                    {data.streaks.problem.count}
                  </Badge>
                )}
                {data.streaks.rateLimited.count > 0 && (
                  <Badge variant="warning">
                    Rate-limit streak:{" "}
                    {data.streaks.rateLimited.lowerBound ? "≥" : ""}
                    {data.streaks.rateLimited.count}
                  </Badge>
                )}
              </div>
            )}
            {data.problemGroups.groups.length > 0 && (
              <div className="text-sm">
                <p className="text-muted-foreground">
                  Problems in the past {data.problemGroups.windowDays} days
                </p>
                <ul className="mt-1 space-y-1">
                  {data.problemGroups.groups.map((g) => (
                    <li key={g.kind} className="flex justify-between gap-4">
                      <span className="capitalize">{g.kind}</span>
                      <span className="text-muted-foreground">
                        {g.count}× · last {formatTime(g.lastAt)}
                        {g.lastMessage ? ` — ${g.lastMessage}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.attempts.length > 0 && (
              <ul>
                {data.attempts.map((a) => (
                  <AttemptRow key={a.id} attempt={a} />
                ))}
              </ul>
            )}
            {data.nextCursor && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Attempts retained for {data.retentionDays} days.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
