/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type {
  ApiTokenSummary,
  GenerateTokenResponse,
  TokensResponse,
} from "../../shared/dashboard-api";
import { ApiError, apiDelete, apiPost } from "../lib/api";
import { formatTime } from "../lib/time";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
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

/** Page header per dashboard convention: eyebrow, title, subtitle, action. */
function PageHeader({ action }: { action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Access
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">API Tokens</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Named credentials, observed use and revocation.
        </p>
      </div>
      {action}
    </div>
  );
}

export function AccessPending() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

export function AccessError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  return (
    <div className="space-y-6">
      <PageHeader />
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm font-medium text-destructive">
            {unauthorized ? "Not authorized" : "Failed to load API Tokens"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {unauthorized
              ? "Your session may have expired — try reloading the page."
              : "Try reloading the page."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Last use is only recorded hourly, so recent use is shown as a window. */
function lastUsedLabel(lastUsedAt: number | null, resolutionMinutes: number) {
  if (lastUsedAt == null) return "Never";
  if (Date.now() - lastUsedAt < resolutionMinutes * 60_000) {
    return "Within the last hour";
  }
  return formatTime(lastUsedAt);
}

/**
 * Secondary, collapsed-by-default connection settings for Current and other
 * FreshRSS-mode GReader clients. Opens by default until a token exists, when
 * the User is most likely setting up a client.
 */
function ConnectionInstructions({
  data,
  defaultOpen,
}: {
  data: TokensResponse;
  defaultOpen: boolean;
}) {
  const rows: Array<[string, string, boolean]> = [
    ["Sync type", data.connection.mode, true],
    ["Server URL", data.connection.serverUrl, true],
    ["Username", data.connection.username, true],
    ["Password", "An API Token created above", false],
  ];
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card className="gap-0 border-border py-0">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-6 py-4 text-left text-sm font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight
            aria-hidden="true"
            className="size-4 transition-transform group-data-[state=open]:rotate-90"
          />
          Current connection instructions
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 px-6 pb-5">
          <p className="text-sm text-muted-foreground">
            In Current choose Settings → Sync → {data.connection.mode}. Other
            Google Reader–compatible clients use the same settings.
          </p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {rows.map(([label, value, mono]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className={mono ? "break-all font-mono" : ""}>{value}</dd>
              </div>
            ))}
          </dl>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/**
 * One-time display of a freshly created token. The raw value lives only in
 * the page's component state, so a reload or navigation discards it.
 */
function TokenResult({
  rawToken,
  onDone,
}: {
  rawToken: string;
  onDone: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyRef = useRef<HTMLButtonElement>(null);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    copyRef.current?.focus();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopyState("copied");
    } catch {
      // Clipboard API unavailable/denied — select the text for manual copy.
      const range = document.createRange();
      if (codeRef.current) range.selectNodeContents(codeRef.current);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      setCopyState("failed");
    }
  }

  return (
    <section
      aria-label="New API Token"
      className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4"
    >
      <p className="text-sm font-medium">
        Copy this API Token now — it will not be shown again.
      </p>
      <code
        ref={codeRef}
        data-testid="raw-token"
        className="block break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-sm"
      >
        {rawToken}
      </code>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={copyRef} type="button" size="sm" onClick={copy}>
          {copyState === "copied" ? "Copied" : "Copy token"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-input"
          onClick={onDone}
        >
          Done
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {copyState === "copied" && "Token copied to clipboard."}
          {copyState === "failed" &&
            "Copy failed — the token is selected; copy it manually."}
        </span>
      </div>
    </section>
  );
}

/** Inline named-creation form opened by the header's Create action. */
function CreateTokenForm({
  onCreated,
  onCancel,
}: {
  onCreated: (rawToken: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<GenerateTokenResponse>("/app/api/tokens", {
        name,
      });
      onCreated(res.rawToken);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      setError(
        status === 400
          ? "Enter a token name (1–100 characters)."
          : `Token creation failed${status ? ` (${status})` : ""}. Try again.`,
      );
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
      aria-label="Create API Token"
      className="space-y-2 rounded-lg border bg-muted/50 p-4"
    >
      <label htmlFor="token-name" className="text-sm font-medium">
        Token name
      </label>
      <p id="token-name-hint" className="text-xs text-muted-foreground">
        Name it after the client that will use it. Each token grants full
        read/write access to your Feeds.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          ref={inputRef}
          id="token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Current on iPhone"
          maxLength={100}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? "token-name-hint token-name-error" : "token-name-hint"
          }
          className="bg-card"
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      {error && (
        <p
          id="token-name-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </form>
  );
}

/** Token row with an inline confirmation step naming the affected token. */
function TokenRow({
  token,
  resolutionMinutes,
  onRevoked,
}: {
  token: ApiTokenSummary;
  resolutionMinutes: number;
  onRevoked: (token: ApiTokenSummary, error?: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const revokeRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  async function revoke() {
    setBusy(true);
    try {
      await apiDelete(`/app/api/tokens/${token.id}`);
      onRevoked(token);
    } catch (err) {
      onRevoked(
        token,
        `Revoking “${token.name}” failed` +
          `${err instanceof ApiError ? ` (${err.status})` : ""}.`,
      );
      setConfirming(false);
      revokeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const revoked = token.revokedAt != null;
  return (
    <TableRow className="border-border hover:bg-transparent">
      <TableCell
        className={`px-3 py-3 font-medium ${revoked ? "text-muted-foreground" : ""}`}
      >
        {token.name}
      </TableCell>
      <TableCell className="px-3 py-3 text-muted-foreground">
        {lastUsedLabel(token.lastUsedAt, resolutionMinutes)}
      </TableCell>
      <TableCell className="px-3 py-3">
        {revoked && (
          <span className="text-muted-foreground">
            Revoked
            <span className="sr-only sm:not-sr-only">
              {" "}
              · {formatTime(token.revokedAt)}
            </span>
          </span>
        )}
        {!revoked && !confirming && (
          <Button
            ref={revokeRef}
            size="sm"
            variant="outline"
            className="border-input"
            aria-label={`Revoke ${token.name}`}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </Button>
        )}
        {!revoked && confirming && (
          <div
            role="group"
            aria-label={`Confirm revoking ${token.name}`}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="basis-full text-xs text-muted-foreground">
              Revoke “{token.name}”? Clients using it lose access.
            </span>
            <Button
              ref={confirmRef}
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={revoke}
            >
              Confirm revoke
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                // the Revoke button remounts after this render
                setTimeout(() => revokeRef.current?.focus());
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Access — compact named API Token management (create with one-time reveal,
 * coarse last use, revocation) with connection instructions secondary.
 */
export function AccessPage({ data }: { data: TokensResponse }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  function handleRevoked(token: ApiTokenSummary, error?: string) {
    setNotice(error ?? `Revoked “${token.name}”.`);
    if (!error) {
      router.invalidate();
      // the row's controls disappear; keep focus within the list
      headingRef.current?.focus();
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        action={
          <Button
            ref={createRef}
            onClick={() => {
              setRawToken(null);
              setNotice(null);
              setCreating(true);
            }}
            aria-expanded={creating}
          >
            Create API Token
          </Button>
        }
      />

      <Card className="gap-4 border-border">
        <CardHeader>
          <CardTitle>
            <h2 ref={headingRef} tabIndex={-1} className="outline-none">
              API Tokens
            </h2>
          </CardTitle>
          <CardDescription>
            Each GReader client signs in with its own named token.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {creating && (
            <CreateTokenForm
              onCreated={(raw) => {
                setCreating(false);
                setRawToken(raw);
                router.invalidate();
              }}
              onCancel={() => {
                setCreating(false);
                createRef.current?.focus();
              }}
            />
          )}
          {rawToken && (
            <TokenResult
              key={rawToken}
              rawToken={rawToken}
              onDone={() => {
                setRawToken(null);
                createRef.current?.focus();
              }}
            />
          )}
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {data.tokens.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-8 text-center">
              <p className="text-sm font-medium">No API Tokens yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create one to connect Current or another GReader client.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-muted [&_tr]:border-0">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 w-[40%] rounded-l-md px-3 text-xs">
                    API Token
                  </TableHead>
                  <TableHead className="h-8 w-[25%] px-3 text-xs">
                    Last observed use
                  </TableHead>
                  <TableHead className="h-8 rounded-r-md px-3 text-xs">
                    State / action
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tokens.map((t) => (
                  <TokenRow
                    key={t.id}
                    token={t}
                    resolutionMinutes={data.lastUsedResolutionMinutes}
                    onRevoked={handleRevoked}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              Last use updates at most hourly. It is not a connection indicator.
            </p>
            <p>Raw API Tokens appear only at creation.</p>
          </div>
        </CardContent>
      </Card>

      <ConnectionInstructions
        data={data}
        defaultOpen={data.tokens.length === 0}
      />
    </div>
  );
}
