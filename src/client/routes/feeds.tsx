/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import type {
  FeedsResponse,
  FeedListItem,
  ImportResponse,
  SyncResponse,
} from "../../shared/dashboard-api";
import { ApiError, apiPost, apiPostForm } from "../lib/api";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

const STATUS_OPTIONS = [
  ["", "All statuses"],
  ["active", "Active"],
  ["new", "New"],
  ["rate_limited", "Rate limited"],
  ["failing", "Failing"],
  ["deactivated", "Deactivated"],
] as const;

function StatusBadge({ status }: { status: FeedListItem["status"] }) {
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

export function FeedsPending() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

export function FeedsError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium">
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

export function FeedsPage({ data }: { data: FeedsResponse }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [folder, setFolder] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.feeds.filter(
      (f) =>
        (q === "" ||
          (f.title ?? "").toLowerCase().includes(q) ||
          f.feedUrl.toLowerCase().includes(q)) &&
        (status === "" || f.status === status) &&
        (folder === "" || f.folder === folder),
    );
  }, [data, query, status, folder]);

  async function runSync(force: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiPost<SyncResponse>("/app/api/feeds/sync", {
        force,
      });
      setNotice(
        `${res.forced ? "Forced sync" : "Sync"} started — ${res.eligible} feed${res.eligible === 1 ? "" : "s"} eligible.`,
      );
      router.invalidate();
    } catch (err) {
      setNotice(
        `Sync failed to start${err instanceof ApiError ? ` (${err.status})` : ""}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function importOpml() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setNotice("Choose an OPML file first.");
      return;
    }
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
      if (fileRef.current) fileRef.current.value = "";
      router.invalidate();
    } catch (err) {
      setNotice(
        `Import failed${err instanceof ApiError ? ` (${err.status})` : ""}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Feeds</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => runSync(false)}>
              Sync now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => runSync(true)}
            >
              Force sync
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".opml,.xml,text/xml"
              aria-label="OPML file"
              className="w-44 text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-2 file:py-1 file:text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={importOpml}
            >
              Import OPML
            </Button>
          </div>
        </div>
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Input
            type="search"
            placeholder="Search title or URL…"
            aria-label="Search subscriptions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-56"
          />
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
      </CardHeader>
      <CardContent>
        {data.feeds.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No subscriptions yet — import an OPML file to get started.
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No subscriptions match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Feed</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Last check</th>
                  <th className="py-2 pr-4 font-medium">Last new item</th>
                  <th className="py-2 pr-4 font-medium">Next check</th>
                  <th className="py-2 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <tr key={f.feedId} className="border-b last:border-0">
                    <td className="max-w-56 py-2.5 pr-4">
                      <Link
                        to="/feeds/$feedId"
                        params={{ feedId: f.feedId }}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {f.title ?? f.feedUrl}
                      </Link>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {f.folder && <span>{f.folder} · </span>}
                        {f.legacyUncertain && <span>reason unknown · </span>}
                        {f.lastError && f.status !== "active" && (
                          <span>{f.lastError}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge status={f.status} />
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {formatTime(f.lastSuccessfulAt)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {formatTime(f.lastNewItemAt)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {f.deactivatedAt != null
                        ? "—"
                        : formatTime(f.nextCheckAt)}
                    </td>
                    <td className="py-2.5">{f.consecutiveErrors || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
