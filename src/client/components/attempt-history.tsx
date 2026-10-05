/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  FeedAttempt,
  FeedAttemptsResponse,
} from "../../shared/dashboard-api";
import { apiGet } from "../lib/api";
import { cn } from "../lib/utils";
import { formatDateTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Table, TableBody, TableCell, TableRow } from "./ui/table";

/** Checks shown in the outcome strip, matching the approved board. */
const STRIP_CHECKS = 10;

/** Short outcome label used across strip, results and badges. */
export function attemptLabel(a: FeedAttempt): string {
  if (a.status === "ok") return a.itemsAdded ? "New items" : "Unchanged";
  if (a.status === "not_modified") return "Not modified";
  if (a.status === "rate_limited") return "Rate limited";
  if (a.status === "error") return "Failed";
  if (a.status === "skipped") return "Skipped";
  return "In progress";
}

/** Outcome plus the structured HTTP status when it adds evidence. */
function outcomeLine(a: FeedAttempt): string {
  const label = attemptLabel(a);
  if (a.status === "rate_limited" || a.status === "error") {
    if (a.httpStatus != null && a.httpStatus !== 200)
      return `${label} · HTTP ${a.httpStatus}`;
    if (a.errorKind) return `${label} · ${errorKindLabel(a.errorKind)}`;
  }
  if (a.status === "not_modified") return `${label} · HTTP 304`;
  return label;
}

function outcomeTextClass(a: FeedAttempt): string {
  if (a.status === "rate_limited") return "text-warning-foreground";
  if (a.status === "error") return "text-destructive";
  if (a.status === "ok" && a.itemsAdded) return "text-primary";
  return "text-muted-foreground";
}

function errorKindLabel(kind: string): string {
  if (kind === "http") return "HTTP error";
  if (kind === "network") return "Network error";
  if (kind === "parse") return "Parse failure";
  return "Unclassified error";
}

/** Parser stage reached — distinguishes fallback, failure and not attempted. */
function parserLabel(state: string | null): string {
  switch (state) {
    case "success":
      return "Parsed";
    case "fallback":
      return "Parsed with fallback parser";
    case "failure":
      return "Parser failed";
    case "not_attempted":
      return "Parser not attempted";
    default:
      return "Parser state not recorded";
  }
}

/**
 * Plain-language reading of one attempt's evidence. Confirmed facts only —
 * possible causes are framed as unproven so a status code is never read as
 * a diagnosis (e.g. a 403 does not prove provider blocking).
 */
function attemptExplanation(a: FeedAttempt): string {
  switch (a.status) {
    case "rate_limited":
      return "Feed server requested Backoff. Current eligibility and interval are shown above.";
    case "error":
      if (a.errorKind === "network")
        return "The request did not complete at the network level. No response was received to classify.";
      if (a.errorKind === "parse")
        return "A response was received but could not be parsed as a Feed. This alone does not prove the publisher's XML is malformed.";
      if (a.httpStatus != null)
        return `The server responded with HTTP ${a.httpStatus}. The status alone does not identify why.`;
      return "The check failed without a recorded classification.";
    case "skipped":
      return "Deliberately skipped — not a check and not a failure.";
    case "in_progress":
      return "This check is still running; its outcome is not known yet.";
    case "not_modified":
      return "The server confirmed nothing changed since the previous check (HTTP 304).";
    default:
      return a.itemsAdded
        ? `The check stored ${a.itemsAdded} new item${a.itemsAdded === 1 ? "" : "s"}.`
        : "The check succeeded with no new items.";
  }
}

/** Outcome strip colors: blue ingestion, amber warning, red failure, neutral otherwise. */
function tickClass(a: FeedAttempt): string {
  if (a.status === "ok" && a.itemsAdded) return "bg-primary text-white";
  if (a.status === "rate_limited") return "bg-warning text-warning-foreground";
  if (a.status === "error") return "bg-destructive text-white";
  if (a.status === "in_progress")
    return "border-2 border-dashed border-primary bg-card text-primary";
  return "bg-muted-foreground/30 text-foreground";
}

function tickText(a: FeedAttempt): string {
  if (a.status === "rate_limited" || a.status === "error") {
    if (a.httpStatus != null && a.httpStatus !== 200)
      return String(a.httpStatus);
    return a.errorKind === "network"
      ? "NET"
      : a.errorKind === "parse"
        ? "XML"
        : "ERR";
  }
  if (a.status === "in_progress") return "…";
  return "";
}

/** Shortened ID for visual scanning; copy controls always use the full value. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export interface FeedAttemptsState {
  data: FeedAttemptsResponse | null;
  error: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
}

/** Loads the Feed's paginated attempt history, appending older pages on demand. */
export function useFeedAttempts(feedId: string): FeedAttemptsState {
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
      setData({ ...res, attempts: [...data.attempts, ...res.attempts] });
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return { data, error, loadingMore, loadMore };
}

/**
 * Describes the current problem streak and when it was first observed. The
 * start is only stated when the whole streak is within the loaded history;
 * otherwise it is reported as a lower bound rather than invented.
 */
export function currentProblem(data: FeedAttemptsResponse): string | null {
  const { problem, rateLimited } = data.streaks;
  const streak = problem.count > 0 ? problem : rateLimited;
  if (streak.count === 0) return null;
  const noun =
    problem.count > 0 ? "consecutive failed" : "consecutive rate-limited";
  const checks = data.attempts.filter(
    (a) => a.status !== "skipped" && a.status !== "in_progress",
  );
  const count = `${streak.lowerBound ? "at least " : ""}${streak.count} ${noun} check${streak.count === 1 ? "" : "s"}`;
  if (streak.lowerBound) {
    return `Current problem started before retained history · ${count}`;
  }
  const first = checks[streak.count - 1];
  if (!first) {
    return `Current problem started before the loaded results · ${count}`;
  }
  return `Current problem started ${formatDateTime(first.startedAt)} · ${count}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs"
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
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Chronological outcome strip of the latest checks, oldest to newest, each
 * the same width regardless of elapsed time. Every tick is a button so the
 * timestamp and result are available without hover.
 */
export function CheckHistory({
  state,
  selectedId,
  onSelect,
}: {
  state: FeedAttemptsState;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data, error } = state;
  const checks = (data?.attempts ?? []).filter((a) => a.status !== "skipped");
  const strip = checks.slice(0, STRIP_CHECKS).reverse();
  const skipped = (data?.attempts ?? []).filter(
    (a) => a.status === "skipped",
  ).length;
  const selected = strip.find((a) => a.id === selectedId) ?? null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Check history</CardTitle>
        <CardDescription className="text-xs">
          {strip.length > 0
            ? `Last ${strip.length} check${strip.length === 1 ? "" : "s"} · oldest to newest · spaced by attempts, not elapsed time`
            : "Outcomes of recorded checks, oldest to newest"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p className="text-sm text-muted-foreground">
            Check history could not be loaded.
          </p>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {data && strip.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {data.historyState === "legacy"
              ? "This Feed was checked before attempt history was recorded. No checks are retained."
              : data.historyState === "empty"
                ? "No checks recorded yet."
                : "No checks in retained history — only skipped attempts."}
          </p>
        )}
        {strip.length > 0 && (
          <>
            <div
              role="group"
              aria-label="Check outcome timeline"
              className="flex gap-1.5"
            >
              {strip.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={selectedId === a.id}
                  aria-label={`${outcomeLine(a)} — ${formatDateTime(a.startedAt)}`}
                  onClick={() => onSelect(a.id)}
                  className={cn(
                    "flex h-8 max-w-12 min-w-0 flex-1 items-center justify-center rounded-sm text-[11px] font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    tickClass(a),
                    selectedId === a.id &&
                      "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                  )}
                >
                  {tickText(a)}
                </button>
              ))}
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <li className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2.5 rounded-sm bg-muted-foreground/30" />
                Unchanged / not modified
              </li>
              <li className="flex items-center gap-1.5 text-primary">
                <span className="size-2.5 rounded-sm bg-primary" />
                New items
              </li>
              <li className="flex items-center gap-1.5 text-warning-foreground">
                <span className="size-2.5 rounded-sm bg-warning" />
                Rate limited
              </li>
              <li className="flex items-center gap-1.5 text-destructive">
                <span className="size-2.5 rounded-sm bg-destructive" />
                Failed
              </li>
            </ul>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {selected
                ? `Selected: ${formatDateTime(selected.startedAt)} · ${outcomeLine(selected)} — details opened in Results.`
                : "Select a check for its timestamp and result."}
              {skipped > 0 &&
                ` ${skipped} skipped attempt${skipped === 1 ? "" : "s"} shown separately in Results.`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function groupLabel(g: { kind: string; httpStatus: number | null }): string {
  if (g.kind === "rate_limited") return "HTTP 429 · rate limited";
  if (g.kind === "http")
    return g.httpStatus != null && g.httpStatus !== 200
      ? `HTTP ${g.httpStatus}`
      : "HTTP error";
  return errorKindLabel(g.kind);
}

/** Problem checks grouped by recorded evidence over the labeled window. */
export function ErrorBreakdown({ state }: { state: FeedAttemptsState }) {
  const { data, error } = state;
  const groups = data?.problemGroups.groups ?? [];
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const max = groups.reduce((m, g) => Math.max(m, g.count), 0);
  const hasNetworkOrParse = groups.some(
    (g) => g.kind === "network" || g.kind === "parse",
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Error breakdown</CardTitle>
        <CardDescription className="text-xs">
          {data
            ? `Past ${data.problemGroups.windowDays} days · ${total} problem check${total === 1 ? "" : "s"}`
            : "Problem checks by recorded evidence"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p className="text-sm text-muted-foreground">
            Error breakdown could not be loaded.
          </p>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {data && groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No failed or rate-limited checks in this window.
          </p>
        )}
        {groups.length > 0 && (
          <ul className="space-y-3">
            {groups.map((g) => (
              <li key={`${g.kind}:${g.httpStatus}`} className="space-y-1">
                <div className="flex justify-between gap-4 text-sm">
                  <span
                    className={cn(
                      "font-semibold",
                      g.kind === "rate_limited"
                        ? "text-warning-foreground"
                        : "text-destructive",
                    )}
                  >
                    {groupLabel(g)}
                  </span>
                  <span className="tabular-nums">{g.count}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-1.5 rounded-full",
                      g.kind === "rate_limited"
                        ? "bg-warning"
                        : "bg-destructive",
                    )}
                    style={{ width: `${(g.count / max) * 100}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Last {formatDateTime(g.lastAt)}
                  {g.lastMessage ? ` · ${g.lastMessage}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {data && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {groups.length > 0 && !hasNetworkOrParse && (
              <p>No network or parse failures in this window.</p>
            )}
            <p>Grouped by recorded evidence, not inferred provider.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ResultsFilter = "all" | "problems" | "successful" | "skipped";

const FILTER_LABELS: Record<ResultsFilter, string> = {
  all: "All results",
  problems: "Problems",
  successful: "Successful checks",
  skipped: "Skipped",
};

function matchesFilter(a: FeedAttempt, filter: ResultsFilter): boolean {
  if (filter === "problems")
    return a.status === "error" || a.status === "rate_limited";
  if (filter === "successful")
    return a.status === "ok" || a.status === "not_modified";
  if (filter === "skipped") return a.status === "skipped";
  return true;
}

function Detail({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

/** One expandable result: summary row plus evidence revealed on demand. */
function ResultRow({
  attempt,
  open,
  onOpenChange,
}: {
  attempt: FeedAttempt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const time = formatDateTime(attempt.startedAt);
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <TableBody id={`attempt-${attempt.id}`} className="border-b">
        <TableRow className="border-0">
          <TableCell className="w-full py-2.5 sm:w-auto">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-auto justify-start gap-2 px-2 py-1 text-left font-medium"
                aria-label={`${outcomeLine(attempt)} at ${time} — ${open ? "hide" : "show"} details`}
              >
                {open ? <ChevronDown /> : <ChevronRight />}
                <span className="flex flex-col sm:block">
                  <span>{time}</span>
                  <span
                    className={cn(
                      "text-xs sm:hidden",
                      outcomeTextClass(attempt),
                    )}
                  >
                    {outcomeLine(attempt)}
                  </span>
                </span>
              </Button>
            </CollapsibleTrigger>
          </TableCell>
          <TableCell
            className={cn(
              "hidden font-medium sm:table-cell",
              outcomeTextClass(attempt),
            )}
          >
            {outcomeLine(attempt)}
            {attempt.itemsAdded ? (
              <span className="ml-1 text-muted-foreground">
                (+{attempt.itemsAdded})
              </span>
            ) : null}
          </TableCell>
          <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
            {attempt.status === "skipped" || attempt.status === "in_progress"
              ? ""
              : parserLabel(attempt.parserState)}
          </TableCell>
          <TableCell className="hidden text-right text-xs whitespace-nowrap text-muted-foreground sm:table-cell">
            {attempt.cycleRunId ? (
              <span title={attempt.cycleRunId}>
                Cycle Run{" "}
                <span className="font-mono">{shortId(attempt.cycleRunId)}</span>
              </span>
            ) : (
              "No Cycle Run"
            )}
          </TableCell>
        </TableRow>
        <CollapsibleContent asChild>
          <TableRow className="border-0 hover:bg-transparent">
            <TableCell colSpan={4} className="pt-0 pb-3 whitespace-normal">
              <div className="space-y-3 rounded-md bg-muted/70 p-3 text-xs sm:p-4">
                <p className="text-sm">{attemptExplanation(attempt)}</p>
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Detail label="HTTP status">
                    {attempt.httpStatus ?? "Not recorded"}
                  </Detail>
                  <Detail label="Problem class">
                    {attempt.errorKind
                      ? errorKindLabel(attempt.errorKind)
                      : attempt.status === "rate_limited"
                        ? "Rate limited"
                        : "None"}
                  </Detail>
                  <Detail label="Parser">
                    {parserLabel(attempt.parserState)}
                  </Detail>
                  <Detail label="Duration">
                    {attempt.durationMs != null
                      ? `${attempt.durationMs} ms`
                      : "Not finished"}
                  </Detail>
                  {attempt.errorMessage && (
                    <Detail label="Diagnostic" className="sm:col-span-2">
                      {attempt.errorMessage}
                    </Detail>
                  )}
                  <Detail label="Attempt ID" className="sm:col-span-2">
                    <span className="font-mono break-all">{attempt.id}</span>{" "}
                    <CopyButton value={attempt.id} label="Copy full ID" />
                  </Detail>
                  <Detail label="Cycle Run" className="sm:col-span-2">
                    {attempt.cycleRunId ? (
                      <>
                        <span className="font-mono break-all">
                          {attempt.cycleRunId}
                        </span>{" "}
                        <CopyButton
                          value={attempt.cycleRunId}
                          label="Copy Cycle Run ID"
                        />
                      </>
                    ) : (
                      "Not recorded"
                    )}
                  </Detail>
                  <Detail label="Items stored" className="sm:col-span-2">
                    {attempt.items.length > 0 ? (
                      <ul className="space-y-0.5">
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
                    ) : attempt.itemsAdded ? (
                      `${attempt.itemsAdded} reported; none still attributed (retention may have removed them)`
                    ) : (
                      "None"
                    )}
                  </Detail>
                </dl>
              </div>
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </TableBody>
    </Collapsible>
  );
}

/** Timestamped, expandable attempt results with filtering and pagination. */
export function Results({
  state,
  openIds,
  onOpenChange,
}: {
  state: FeedAttemptsState;
  openIds: Set<string>;
  onOpenChange: (id: string, open: boolean) => void;
}) {
  const { data, error, loadingMore, loadMore } = state;
  const [filter, setFilter] = useState<ResultsFilter>("all");
  const rows = (data?.attempts ?? []).filter((a) => matchesFilter(a, filter));
  const problem = data ? currentProblem(data) : null;

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Results</CardTitle>
          <CardDescription className="text-xs">
            {problem ?? "Every recorded attempt, newest first"}
          </CardDescription>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm">
              {FILTER_LABELS[filter]}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(v) => setFilter(v as ResultsFilter)}
            >
              {(Object.keys(FILTER_LABELS) as ResultsFilter[]).map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {FILTER_LABELS[key]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p className="text-sm text-muted-foreground">
            Results could not be loaded.
          </p>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {data?.historyState === "legacy" && (
          <p className="text-sm text-muted-foreground">
            This Feed was checked before attempt history was recorded — earlier
            checks are unknown.
          </p>
        )}
        {data?.historyState === "empty" && (
          <p className="text-sm text-muted-foreground">
            No checks recorded yet.
          </p>
        )}
        {data && data.attempts.length > 0 && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No {FILTER_LABELS[filter].toLowerCase()} in the loaded results.
          </p>
        )}
        {rows.length > 0 && (
          <Table aria-label="Attempt results" className="border-t">
            {rows.map((a) => (
              <ResultRow
                key={a.id}
                attempt={a}
                open={openIds.has(a.id)}
                onOpenChange={(open) => onOpenChange(a.id, open)}
              />
            ))}
          </Table>
        )}
        {data && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              History retained for {data.retentionDays} days. Earlier or expired
              history is unknown.
            </p>
            {data.nextCursor && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? "Loading…" : "Older results"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
