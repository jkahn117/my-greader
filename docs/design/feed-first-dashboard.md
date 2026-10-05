# Feed-first dashboard direction

Status: [visual revision 05 is ready for review](dashboard-directions.svg). The landing page is a deployment Overview with both reading activity and health. Feeds owns the status listing and diagnostic drill-down. Reading offers deeper metrics; Access stays simple. The blue/graphite palette and Feed detail are retained. All values are illustrative; no runtime changes.

## Organize around the operator's questions

The interface has one primary User. Do not devote prominent space to comparing global versus personal activity, but preserve accurate scope in metric descriptions and server-side ownership checks.

Navigation is Overview, Feeds, Reading and Access.

- Overview is the at-a-glance view of the deployment. Pair reading activity with health rather than making it a health-only console. Summaries link into the relevant detail pages.
- Feeds lists all Subscriptions with current status, search and status/Folder filters. Rows open Feed detail. Issues can sort first, but the page is not only a list of failures.
- Reading owns longer-range and per-Feed read/star state metrics. Expand it after the Current experiment if distinct action signals are verified.
- Access is a small, rarely visited management page, not a prominent overview panel.

The diagnostic workflow remains **Overview → Feed → polling history across Cycle Runs → individual result.** A Cycle Run is a correlation tool, not the object the User starts with. Run history stays under operational detail.

### Overview

Use a mixed summary row ordered as Feed count, New Items over the past seven days, Items marked read over the past seven days, and Feeds needing attention. New Items replaces Currently starred and is immediately left of Items marked read. Scope New Items to the authenticated User's Subscriptions, not the existing global aggregate.

Pair the marked-read chart and top-Feed reading summary with a card named Feed health, since polling outcomes describe Feeds rather than infrastructure health. Put this reading/health row above the compact Needs attention list, whose rows link to affected Feeds. Latest polling activity remains in the header rather than another large console section.

Health should answer whether polling is happening and whether problems are isolated or widespread. Detailed overdue-work and scheduler diagnostics stay in operational detail. Distinguish a quiet publisher from an overdue successful check. A completed Cycle Run alone does not prove all Feeds are healthy, and an empty run can be normal.

Group current Feed issues into failed, rate limited, automatically deactivated and manually paused. Separate incomplete work from deliberate skips and Backoff. Avoid an invented health score or a generic reassuring green banner.

Polling freshness, overdue eligible work and health over a time window need explicitly defined projections; they should not be guessed from the latest run alone.

### Feed health

The default Feed list should make deteriorating Feeds visible first. Each row summarizes current state, last successful check, problem streak, dominant recent error and next eligibility.

Selecting kottke.org opens a full Feed page, not a Cycle Run sheet. Its overview should explain the situation in words, followed by evidence:

- Current state and current Backoff interval.
- Consecutive problem attempts, first observed problem and last successful check. Distinguish a persisted failure counter from a derived sequence of failed or rate-limited attempts.
- Error distribution over a labeled window, grouped by structured HTTP status and network/parse class.
- A chronological strip of polling outcomes across Cycle Runs. Normal not-modified/unchanged results remain neutral; new Items, rate limiting, failed and skipped attempts are distinct.
- An error list with timestamps, classifications, sanitized diagnostics and expansion into the individual result. Cycle Run links are secondary correlation controls.
- Last new Item, backload state, and migration uncertainty in supporting detail.

Count checks, not elapsed scheduler cycles. A Feed can be ineligible during Backoff, so ten system Cycle Runs do not imply ten failed checks. Skipped attempts are not HTTP failures. Bound and label all history; expired history is unknown, not successful.

For example, "HTTP 429 on the last three checks; Backoff active" is useful if the history supports it. "Cloudflare is blocking this Feed" is not justified by HTTP 403 alone. HTTP 403 proves a forbidden response, not its provider or root cause. A parse failure also does not prove the Feed publisher broke its XML; the response may be an HTML error page. HTTP 404/410 and redirects can inform investigation but should not automatically establish that a Feed moved.

### Reading signals

The overview shows a small reading summary; the Reading page expands it with daily trends, marked-read counts by Feed, current starred counts and useful time-window controls. Per-Feed marked-read metrics can be derived from existing Item State joined to Items and Subscriptions, with the same receipt-time and retention caveats as the current daily chart. They need a new read projection, not a new signal from Current. Do not calculate a completion ratio by dividing marked-read counts by newly fetched Items, since those are different cohorts.

The dashboard should describe observed client state, not infer actual human reading. Until Current's sync behavior is verified, label charts "Items marked read" and "Items starred" rather than "Items read", "completion rate", "reading time" or "skipped".

Current's first-party docs distinguish Mark Read, Release and age-based removal in the UI. Whether its FreshRSS integration sends different API operations for those actions is a separate question. Google Reader read/star state alone cannot encode their reasons. See [the Current reading-signal research note](current-reading-signals.md). The experiment is deferred to [GitHub issue #41](https://github.com/jkahn117/my-greader/issues/41) and does not block this design.

Our `read_at` currently stores server time when a read=true update arrives, including repeated updates. Unread clears it, bulk mark-read writes it, and Item retention can delete it. The D1 chart is therefore current read-state rows grouped by latest received mark-read time, not an append-only activity log or an exact event count. Offline queues also prevent treating server receipt time as the reading time.

A durable reading-event projection would require explicit state transitions and retention policy. That is separate from a visual refresh and still cannot invent a missing client action reason.

### Access management

Keep a dedicated page for named API Tokens, creation, last observed use, revocation and client setup. Last use is coarse, updated at most hourly, not a live connection indicator. Never display token secrets after generation or use them in diagnostic logs.

## What is available, and what needs work

D1 retains per-Feed attempts with timestamps, Cycle Run identity, outcome, HTTP status, parser status and sanitized diagnostic text. Operational history retention is 90 days. This is enough to build bounded Feed-specific history and error aggregations without changing polling identity.

The current Timeline projection covers only the latest 20 global Cycle Runs. Do not reuse it as complete Feed history; backed-off Feeds may have sparse attempts. Add a bounded Feed-history and health read interface under the existing Activity module with Subscription ownership, stable ordering and pagination. Add query indexes as required by its access patterns.

A specific current gap matters: HTTP 429 has a dedicated rate-limited outcome and updates Backoff without incrementing `consecutive_errors`. A health summary based solely on failed Cycle Run counts or that counter would hide rate limiting. Derive the displayed rate-limit/problem streak from retained attempts and label its meaning.

Provider-specific blocking, redirect destinations, response content type and historical Retry-After details are not currently retained as structured evidence. Add a small safe allowlist of response metadata only if those diagnoses are needed. Do not store arbitrary response bodies or headers, or infer Cloudflare blocking from status alone. Keep confirmed evidence separate from investigation suggestions.

## Visual revision 05

The board combines reading and Feed health on Overview, above the attention list. New Items over seven days replaces the starred summary and sits left of Items marked read. Its compact attention list is a shortcut, not the full Feed listing. Reading detail adds a per-Feed breakdown using known state. Access stays a basic Token list and creation/revocation controls.

The complete implementation spec is in [dashboard-spec.md](dashboard-spec.md). It records the test-seam confirmation gate and the non-blocking Current experiment.

Feed detail is unchanged apart from the navigation label. It remains a full page with current Backoff, cross-Cycle-Run outcome history, structured error aggregation and expandable results. Cycle Run links are secondary. The all-Feeds listing is specified above but not separately illustrated on this board.

The Reading view uses current read-state rows grouped by latest server receipt and current starred state. It has no released/expired counts, completion rate or reading-duration estimate. A separate experiment can refine those labels later if Current sends a verifiable distinction.

The board is static. Implementation still needs accessible charts and table alternatives, mobile layouts, loading/error/empty states and explicitly unavailable history. New Feed-history and system-summary read projections are required, but no unverified Current signal is required.

The accepted runtime direction remains React + Vite + TanStack Router, actual shadcn components, Hono JSON endpoints and existing Feed modules. No TanStack Query yet. The GReader protocol must not change to accommodate unverified analytics.
