export interface SubscriptionRow {
  id: string
  feedId: string
  title: string | null
  feedUrl: string
  htmlUrl: string | null
  folder: string | null
  lastFetchedAt: number | null
  consecutiveErrors: number
  lastError: string | null
  deactivatedAt: number | null
}

function formatDate(ts: number | null) {
  if (!ts) return <span>Never</span>
  return <time datetime={String(ts)}>{new Date(ts).toISOString()}</time>
}

// Status badge — green (active), yellow (errors), red (deactivated)
function StatusBadge({ sub }: { sub: SubscriptionRow }) {
  if (sub.deactivatedAt) {
    return (
      <span
        class="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
        title={sub.lastError ?? 'Deactivated'}
      >
        Deactivated
      </span>
    )
  }
  if (sub.consecutiveErrors > 0) {
    return (
      <span
        class="inline-flex items-center rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-600"
        title={sub.lastError ?? `${sub.consecutiveErrors} consecutive error(s)`}
      >
        {sub.consecutiveErrors} error{sub.consecutiveErrors > 1 ? 's' : ''}
      </span>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Single feed row — exported for htmx OOB swap after reactivation
// ---------------------------------------------------------------------------

export function FeedRow({ sub }: { sub: SubscriptionRow }) {
  return (
    <tr id={`feed-${sub.feedId}`} class="border-b border-border last:border-0">
      <td class="py-3 pr-4 font-medium text-foreground">
        <div class="flex items-center gap-2">
          {sub.htmlUrl
            ? <a href={sub.htmlUrl} target="_blank" rel="noopener noreferrer" class="hover:underline">{sub.title ?? '(untitled)'}</a>
            : sub.title ?? '(untitled)'
          }
          <StatusBadge sub={sub} />
        </div>
        {sub.lastError && (
          <p class="mt-0.5 text-xs text-muted-foreground truncate max-w-xs" title={sub.lastError}>
            {sub.lastError}
          </p>
        )}
      </td>
      <td class="py-3 pr-4 text-muted-foreground">
        {sub.folder ?? <span class="italic">None</span>}
      </td>
      <td class="py-3 pr-4 text-muted-foreground whitespace-nowrap">
        {formatDate(sub.lastFetchedAt)}
      </td>
      <td class="py-3 pr-4 max-w-xs truncate text-muted-foreground">
        <a href={sub.feedUrl} target="_blank" rel="noopener noreferrer" class="hover:underline font-mono text-xs">
          {sub.feedUrl}
        </a>
      </td>
      <td class="py-3 text-right">
        {sub.deactivatedAt && (
          <button
            hx-post={`/feeds/${sub.feedId}/reactivate`}
            hx-target={`#feed-${sub.feedId}`}
            hx-swap="outerHTML"
            class="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-opacity hover:opacity-80"
          >
            Reactivate
          </button>
        )}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Subscription list content — exported for OOB swap after OPML import
// ---------------------------------------------------------------------------

/**
 * Inner content of the subscription card. Exported so the import handler can
 * return it as an htmx OOB swap to refresh the list without a page reload.
 */
export function SubscriptionListContent({ subs, oob }: { subs: SubscriptionRow[]; oob?: boolean }) {
  return (
    <div id="subscription-list" class="px-6 py-2" hx-swap-oob={oob ? 'true' : undefined}>
      {subs.length === 0
        ? (
          <p class="py-6 text-center text-sm text-muted-foreground">
            No subscriptions yet. Import an OPML file below.
          </p>
        )
        : (
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border">
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Title</th>
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Folder</th>
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">Last fetched</th>
                <th class="pb-2 pt-3 text-left text-xs font-medium text-muted-foreground">URL</th>
                <th class="pb-2 pt-3 text-right text-xs font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {subs.map(sub => <FeedRow sub={sub} />)}
            </tbody>
          </table>
        )
      }
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manage feeds card
// ---------------------------------------------------------------------------

function ManageFeedsCard({ subs }: { subs: SubscriptionRow[] }) {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="text-base font-semibold text-foreground">Subscriptions</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Your current feed subscriptions. Deactivated feeds are skipped during fetch cycles.
          </p>
        </div>
        <div class="shrink-0">
          <button
            hx-post="/feeds/sync"
            hx-target="#sync-result"
            hx-swap="innerHTML"
            hx-disabled-elt="this"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            Sync now
          </button>
          <div id="sync-result" class="mt-1 text-right" />
        </div>
      </div>
      <SubscriptionListContent subs={subs} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// OPML import card
// ---------------------------------------------------------------------------

function ImportOpmlCard() {
  return (
    <div class="rounded-lg border border-border bg-card shadow-sm">
      <div class="border-b border-border px-6 py-4">
        <h2 class="text-base font-semibold text-foreground">Import OPML</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">
          Upload an OPML file exported from your previous RSS reader.
          Folder names are preserved; duplicate feeds are skipped.
        </p>
      </div>
      <div class="px-6 py-5 space-y-4">
        <form
          hx-post="/import"
          hx-target="#import-result"
          hx-swap="innerHTML"
          hx-encoding="multipart/form-data"
          hx-disabled-elt="find button[type='submit']"
          class="flex items-center gap-3"
        >
          <input
            type="file"
            name="opml"
            accept=".opml,.xml"
            required
            class="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-0.5 file:text-xs file:font-medium"
          />
          <button
            type="submit"
            class="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            <span class="htmx-indicator mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
            Import
          </button>
        </form>
        <div id="import-result" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Full Feed tab page content
// ---------------------------------------------------------------------------

export function FeedTab({ subs }: { subs: SubscriptionRow[] }) {
  return (
    <div class="space-y-8">
      <ManageFeedsCard subs={subs} />
      <ImportOpmlCard />
    </div>
  )
}
