/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
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
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

export function AccessPending() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  );
}

export function AccessError({ status }: { status?: number }) {
  const unauthorized = status === 401 || status === 403;
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium">
          {unauthorized ? "Not authorized" : "Failed to load API tokens"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {unauthorized
            ? "Your session may have expired — try reloading the page."
            : "Try reloading the page."}
        </p>
      </CardContent>
    </Card>
  );
}

/** Last-use is only recorded hourly, so recent use is shown as a window. */
function lastUsedLabel(lastUsedAt: number | null, resolutionMinutes: number) {
  if (lastUsedAt == null) return "Never";
  if (Date.now() - lastUsedAt < resolutionMinutes * 60_000) {
    return "Within the last hour";
  }
  return formatTime(lastUsedAt);
}

/** Connection settings for Current and other FreshRSS-mode GReader clients. */
function ConnectionCard({ data }: { data: TokensResponse }) {
  const rows: Array<[string, string]> = [
    ["Sync type", data.connection.mode],
    ["Server URL", data.connection.serverUrl],
    ["Username", data.connection.username],
    ["Password", "An API token generated below"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a reader</CardTitle>
        <CardDescription>
          In Current choose Settings → Sync → {data.connection.mode}. Other
          Google Reader–compatible clients use the same {data.connection.mode}{" "}
          settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * One-time display of a freshly generated token. The raw value lives only in
 * this component's parent state, so a reload or navigation discards it.
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
      aria-label="New API token"
      className="space-y-3 rounded-lg border border-border bg-muted p-4"
    >
      <p className="text-sm font-medium">
        Copy this token now — it will not be shown again.
      </p>
      <code
        ref={codeRef}
        data-testid="raw-token"
        className="block break-all rounded-md bg-card px-3 py-2 font-mono text-sm"
      >
        {rawToken}
      </code>
      <div className="flex items-center gap-2">
        <Button ref={copyRef} type="button" size="sm" onClick={copy}>
          {copyState === "copied" ? "Copied" : "Copy token"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
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

/** Token name form plus the one-time result block. */
function GenerateCard({ onGenerated }: { onGenerated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRawToken(null);
    try {
      const res = await apiPost<GenerateTokenResponse>("/app/api/tokens", {
        name,
      });
      setRawToken(res.rawToken);
      setName("");
      onGenerated();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      setError(
        status === 400
          ? "Enter a token name (1–100 characters)."
          : `Token generation failed${status ? ` (${status})` : ""}. Try again.`,
      );
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate token</CardTitle>
        <CardDescription>
          Name the token after the client that will use it. Each token grants
          full read/write access to your feeds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={generate} className="flex gap-3">
          <label htmlFor="token-name" className="sr-only">
            Token name
          </label>
          <Input
            ref={inputRef}
            id="token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Current on iPhone"
            maxLength={100}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "token-name-error" : undefined}
          />
          <Button type="submit" disabled={busy}>
            Generate
          </Button>
        </form>
        {error && (
          <p
            id="token-name-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {rawToken && (
          <TokenResult
            key={rawToken}
            rawToken={rawToken}
            onDone={() => {
              setRawToken(null);
              inputRef.current?.focus();
            }}
          />
        )}
      </CardContent>
    </Card>
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
    <tr className="border-b border-border last:border-0">
      <td className="py-3 pr-4 font-medium">{token.name}</td>
      <td className="py-3 pr-4 text-muted-foreground">
        {formatTime(token.createdAt)}
      </td>
      <td className="py-3 pr-4 text-muted-foreground">
        {lastUsedLabel(token.lastUsedAt, resolutionMinutes)}
      </td>
      <td className="py-3 pr-4">
        {revoked ? (
          <Badge variant="secondary">
            Revoked {formatTime(token.revokedAt)}
          </Badge>
        ) : (
          <Badge variant="default">Active</Badge>
        )}
      </td>
      <td className="py-3 text-right">
        {!revoked && !confirming && (
          <Button
            ref={revokeRef}
            size="sm"
            variant="outline"
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
            className="flex flex-wrap items-center justify-end gap-2"
          >
            <span className="text-xs text-muted-foreground">
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
      </td>
    </tr>
  );
}

/**
 * Access — connection instructions, token generation with one-time reveal,
 * and the User's token list with revocation.
 */
export function AccessPage({ data }: { data: TokensResponse }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

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
      <ConnectionCard data={data} />
      <GenerateCard
        onGenerated={() => {
          setNotice(null);
          router.invalidate();
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 ref={headingRef} tabIndex={-1} className="outline-none">
              API tokens
            </h2>
          </CardTitle>
          <CardDescription>
            Last use is recorded at most once every{" "}
            {data.lastUsedResolutionMinutes} minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {data.tokens.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No API tokens yet. Generate one above.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Last used</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tokens.map((t) => (
                  <TokenRow
                    key={t.id}
                    token={t}
                    resolutionMinutes={data.lastUsedResolutionMinutes}
                    onRevoked={handleRevoked}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
