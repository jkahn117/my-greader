import type { InferSelectModel } from 'drizzle-orm'
import type { apiTokens } from '../db/schema'

type ApiToken = InferSelectModel<typeof apiTokens>

// ---------------------------------------------------------------------------
// Token list — rendered server-side; updated via htmx OOB swap on generate
// ---------------------------------------------------------------------------

interface TokenRowProps {
  token: ApiToken
}

/** Single row — has its own ID so htmx can target it for revoke */
export function TokenRow({ token }: TokenRowProps) {
  const lastUsed = token.lastUsedAt
    ? new Date(token.lastUsedAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : 'Never'

  return (
    <tr id={`token-${token.id}`} class="border-b border-border last:border-0">
      <td class="py-3 pr-4 text-sm font-medium text-foreground">{token.name}</td>
      <td class="py-3 pr-4 text-sm text-muted-foreground">{lastUsed}</td>
      <td class="py-3 text-right">
        <button
          hx-delete={`/tokens/${token.id}`}
          hx-target={`#token-${token.id}`}
          hx-swap="outerHTML"
          hx-confirm="Revoke this token? Any client using it will lose access."
          class="rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-80"
        >
          Revoke
        </button>
      </td>
    </tr>
  )
}

/** tbody — also rendered on OOB swap after generating a new token.
 *  Pass oob=true to add hx-swap-oob="true" for out-of-band htmx updates. */
export function TokenList({ tokens, oob }: { tokens: ApiToken[]; oob?: boolean }) {
  return (
    <tbody id="token-list" hx-swap-oob={oob ? 'true' : undefined}>
      {tokens.length === 0
        ? (
          <tr>
            <td colspan={3} class="py-6 text-center text-sm text-muted-foreground">
              No active tokens. Generate one below.
            </td>
          </tr>
        )
        : tokens.map(t => <TokenRow token={t} />)
      }
    </tbody>
  )
}

// ---------------------------------------------------------------------------
// Generate token card
// ---------------------------------------------------------------------------

/** Fragment returned by POST /tokens/generate — shown once, then persists */
export function TokenReveal({ rawToken }: { rawToken: string }) {
  return (
    <div class="rounded-lg border border-border bg-muted p-4">
      <p class="mb-2 text-sm font-medium text-foreground">
        Token generated — copy it now. It will not be shown again.
      </p>
      <code class="block break-all rounded-md bg-card px-3 py-2 font-mono text-sm text-foreground">
        {rawToken}
      </code>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Full Access tab page content
// ---------------------------------------------------------------------------

interface AccessTabProps {
  tokens: ApiToken[]
}

export function AccessTab({ tokens }: AccessTabProps) {
  return (
    <div class="space-y-8">
      {/* Token list card */}
      <div class="rounded-lg border border-border bg-card shadow-sm">
        <div class="border-b border-border px-6 py-4">
          <h2 class="text-base font-semibold text-foreground">Active tokens</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            API tokens used by GReader clients (e.g. Current). Each token grants full read/write access.
          </p>
        </div>
        <div class="px-6 py-2">
          <table class="w-full">
            <thead>
              <tr class="border-b border-border">
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Name</th>
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Last used</th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <TokenList tokens={tokens} />
          </table>
        </div>
      </div>

      {/* Generate new token card */}
      <div class="rounded-lg border border-border bg-card shadow-sm">
        <div class="border-b border-border px-6 py-4">
          <h2 class="text-base font-semibold text-foreground">Generate token</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Give the token a name to identify which client is using it.
          </p>
        </div>
        <div class="px-6 py-5 space-y-4">
          <form
            hx-post="/tokens/generate"
            hx-target="#generate-result"
            hx-swap="innerHTML"
            class="flex gap-3"
          >
            <input
              type="text"
              name="name"
              placeholder="e.g. Current on iPhone"
              required
              class="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              class="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-80"
            >
              Generate
            </button>
          </form>
          <div id="generate-result" />
        </div>
      </div>
    </div>
  )
}
