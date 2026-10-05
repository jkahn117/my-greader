/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRight, Search, Upload } from "lucide-react";
import type {
  FeedsResponse,
  FeedListItem,
  ImportResponse,
} from "../../shared/dashboard-api";
import { ApiError, apiPostForm } from "../lib/api";
import { formatTime } from "../lib/time";
import { SyncButton } from "../components/sync-button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

/**
 * Display state of a Subscription. Splits the API's single `deactivated`
 * status into deliberate manual pauses, automatic deactivation and legacy
 * deactivations whose reason was never recorded.
 */
type DisplayStatus =
  | "failing"
  | "auto_deactivated"
  | "legacy_deactivated"
  | "rate_limited"
  | "new"
  | "healthy"
  | "paused";

const PILL: Record<
  DisplayStatus,
  {
    label: string;
    variant: "warning" | "destructive" | "outline" | "secondary";
  }
> = {
  failing: { label: "Failing", variant: "destructive" },
  auto_deactivated: { label: "Auto-deactivated", variant: "destructive" },
  legacy_deactivated: { label: "Deactivated", variant: "destructive" },
  rate_limited: { label: "Rate limited", variant: "warning" },
  new: { label: "New", variant: "outline" },
  healthy: { label: "Healthy", variant: "secondary" },
  paused: { label: "Paused", variant: "outline" },
};

/** Severity rank — deteriorating Feeds sort first, deliberate pauses last. */
const RANK: Record<DisplayStatus, number> = {
  failing: 0,
  auto_deactivated: 1,
  legacy_deactivated: 2,
  rate_limited: 3,
  new: 4,
  healthy: 5,
  paused: 6,
};

const STATUS_OPTIONS: [DisplayStatus | "deactivated" | "", string][] = [
  ["", "All statuses"],
  ["failing", "Failing"],
  ["rate_limited", "Rate limited"],
  ["deactivated", "Deactivated"],
  ["paused", "Manually paused"],
  ["new", "New"],
  ["healthy", "Healthy"],
];

/** Maps the API status + deactivation reason onto a labeled display state. */
function displayStatus(f: FeedListItem): DisplayStatus {
  if (f.status === "deactivated") {
    if (f.deactivatedReason === "manual") return "paused";
    if (f.deactivatedReason?.startsWith("automatic")) return "auto_deactivated";
    return "legacy_deactivated";
  }
  if (f.status === "active") return "healthy";
  return f.status;
}

/** Whether a row matches the status filter ("deactivated" spans auto + legacy). */
function matchesStatus(s: DisplayStatus, filter: string): boolean {
  if (filter === "") return true;
  if (filter === "deactivated")
    return s === "auto_deactivated" || s === "legacy_deactivated";
  return s === filter;
}

/** Next-eligibility cell text; deactivated Feeds are never scheduled. */
function nextEligibility(f: FeedListItem): string {
  if (f.deactivatedAt != null) return "Not scheduled";
  if (f.nextCheckAt == null) return "Next cycle";
  if (f.nextCheckAt <= Date.now()) return "Eligible now";
  return formatTime(f.nextCheckAt);
}

/** Secondary evidence line under a Feed title (folder, reason, last error). */
function evidence(f: FeedListItem, s: DisplayStatus): string[] {
  const parts: string[] = [];
  if (f.folder) parts.push(f.folder);
  if (s === "paused") parts.push("Manually paused");
  if (s === "legacy_deactivated")
    parts.push("Deactivated before reason tracking — cause unknown");
  if (s === "rate_limited") parts.push("HTTP 429 on latest check");
  if (f.lastError && s !== "healthy" && s !== "paused") parts.push(f.lastError);
  return parts;
}

export function FeedsPending() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Card>
        <CardContent className="space-y-3 py-6">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function FeedsError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          {unauthorized ? "Not authorized" : "Failed to load feeds"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {unauthorized
            ? "Your session may have expired — try reloading the page."
            : "The subscription list could not be loaded."}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * OPML import control: a hidden file input driven by an outline button so
 * the header keeps a single primary action (Sync now). Choosing a file
 * imports immediately and refreshes the listing.
 */
function ImportOpml() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function importFile(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("opml", file);
      const res = await apiPostForm<ImportResponse>("/app/api/import", form);
      const parts = [
        `${res.imported} imported`,
        `${res.duplicates} duplicate${res.duplicates === 1 ? "" : "s"} skipped`,
      ];
      if (res.errors.length > 0)
        parts.push(`${res.errors.length} failed (${res.errors.join(", ")})`);
      setNotice(parts.join(" · "));
      await router.invalidate();
    } catch (err) {
      setNotice(
        `Import failed${err instanceof ApiError ? ` (${err.status})` : ""}.`,
      );
    } finally {
      if (fileRef.current) fileRef.current.value = "";
      setBusy(false);
      buttonRef.current?.focus();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={fileRef}
        type="file"
        accept=".opml,.xml,text/xml"
        aria-label="OPML file"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importFile(file);
        }}
      />
      <Button
        ref={buttonRef}
        variant="outline"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        <Upload />
        {busy ? "Importing…" : "Import OPML"}
      </Button>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}

/**
 * Feeds — the complete Subscription listing. Rows are sorted by severity so
 * deteriorating Feeds surface first; each row links to full Feed detail.
 */
export function FeedsPage({ data }: { data: FeedsResponse }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [folder, setFolder] = useState("");

  const rows = useMemo(
    () =>
      data.feeds
        .map((feed) => ({ feed, status: displayStatus(feed) }))
        .sort(
          (a, b) =>
            RANK[a.status] - RANK[b.status] ||
            b.feed.consecutiveErrors - a.feed.consecutiveErrors ||
            (a.feed.title ?? a.feed.feedUrl).localeCompare(
              b.feed.title ?? b.feed.feedUrl,
            ),
        ),
    [data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      ({ feed: f, status: s }) =>
        (q === "" ||
          (f.title ?? "").toLowerCase().includes(q) ||
          f.feedUrl.toLowerCase().includes(q)) &&
        matchesStatus(s, status) &&
        (folder === "" || f.folder === folder),
    );
  }, [rows, query, status, folder]);

  const attention = rows.filter(
    (r) => RANK[r.status] <= RANK.rate_limited,
  ).length;
  const paused = rows.filter((r) => r.status === "paused").length;
  const filtering = query !== "" || status !== "" || folder !== "";

  const selectClass =
    "h-9 rounded-md border border-input bg-card px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Feeds
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            Your Subscriptions
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {data.feeds.length} Feed{data.feeds.length === 1 ? "" : "s"} ·{" "}
            {attention} need{attention === 1 ? "s" : ""} attention
            {paused > 0 ? ` · ${paused} manually paused` : ""}. Problems sort
            first; open a Feed for its check history.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ImportOpml />
          <SyncButton />
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-col gap-2 border-b py-4 sm:flex-row [.border-b]:pb-4 sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search title or URL…"
              aria-label="Search subscriptions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="bg-card pl-8"
            />
          </div>
          <div className="flex gap-2">
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={selectClass}
            >
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className={selectClass}
            >
              <option value="">All folders</option>
              {data.folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground sm:ml-auto">
            Showing {filtered.length} of {data.feeds.length}
          </p>
        </CardHeader>
        <CardContent className="px-0">
          {data.feeds.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium">No subscriptions yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Import an OPML file or subscribe from your reader to get
                started.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium">
                No subscriptions match the current filters
              </p>
              {filtering && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStatus("");
                    setFolder("");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Feed</TableHead>
                  <TableHead className="hidden md:table-cell">Status</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Last successful check
                  </TableHead>
                  <TableHead className="hidden md:table-cell">
                    Last new Item
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Next eligible
                  </TableHead>
                  <TableHead className="hidden text-right lg:table-cell">
                    Consecutive errors
                  </TableHead>
                  <TableHead className="w-8 pr-4">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(({ feed: f, status: s }) => {
                  const pill = PILL[s];
                  const lines = evidence(f, s);
                  const uncertain = f.legacyUncertain ? " (legacy)" : "";
                  return (
                    <TableRow key={f.subscriptionId}>
                      <TableCell className="max-w-0 py-3 pl-6 md:w-[38%]">
                        <Link
                          to="/feeds/$feedId"
                          params={{ feedId: f.feedId }}
                          className="block truncate font-semibold text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:text-primary"
                        >
                          {f.title ?? f.feedUrl}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {f.feedUrl}
                        </p>
                        <Badge
                          variant={pill.variant}
                          className="my-1 md:hidden"
                        >
                          {pill.label}
                        </Badge>
                        {lines.length > 0 && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {lines.join(" · ")}
                          </p>
                        )}
                        {f.legacyUncertain && (
                          <p className="mt-0.5 text-xs text-muted-foreground italic">
                            Legacy poll state — timestamps may be inferred
                          </p>
                        )}
                        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs whitespace-nowrap text-muted-foreground md:hidden">
                          <dt>Last success</dt>
                          <dd>
                            {formatTime(f.lastSuccessfulAt)}
                            {uncertain}
                          </dd>
                          <dt>Last new Item</dt>
                          <dd>
                            {formatTime(f.lastNewItemAt)}
                            {uncertain}
                          </dd>
                          <dt>Next eligible</dt>
                          <dd>{nextEligibility(f)}</dd>
                          {f.consecutiveErrors > 0 && (
                            <>
                              <dt>Consecutive errors</dt>
                              <dd>{f.consecutiveErrors}</dd>
                            </>
                          )}
                        </dl>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant={pill.variant}>{pill.label}</Badge>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        {formatTime(f.lastSuccessfulAt)}
                        {uncertain && (
                          <span className="text-xs text-muted-foreground">
                            {uncertain}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        {formatTime(f.lastNewItemAt)}
                        {uncertain && (
                          <span className="text-xs text-muted-foreground">
                            {uncertain}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap lg:table-cell">
                        {nextEligibility(f)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums lg:table-cell">
                        {f.consecutiveErrors || "—"}
                      </TableCell>
                      <TableCell className="pr-4">
                        <ChevronRight
                          aria-hidden
                          className="size-4 text-muted-foreground"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
