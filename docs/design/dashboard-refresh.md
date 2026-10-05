# Dashboard refresh proposal

Status: the blue/graphite palette is accepted, but the Cycle-Run-first information hierarchy below is superseded by [the Feed-first direction](feed-first-dashboard.md). React + Vite + TanStack Router is the agreed frontend direction; migration has not started. TanStack Query is deferred.

[Open the visual design board](dashboard-directions.svg). All values and Feed names on the board are illustrative. No dashboard routes or styles have changed.

## Recommendation

Keep the original overview layout, but reject its calm sage-and-cream palette. Use cool gray surfaces, a graphite navigation rail, saturated blue actions and polling charts, and violet reading charts. Blend personal activity and service health on one overview. Put diagnostic detail in a side sheet rather than treating it as a separate dashboard direction.

The current dashboard gives nearly every metric its own full-width bordered card. That makes reading activity, polling errors and interval distributions look equally important. The narrow `max-w-4xl` shell also leaves the new Subscription columns cramped. More cards won't solve that.

The proposed overview answers two questions first: do any of my Feeds need attention, and is polling working? Reading activity follows without introducing unread counts or backlog pressure. Current remains the reading client.

## Revised interaction

The design board now shows two connected views, not competing dashboard options:

1. Overview combines your reading week, Subscription activity, polling activity and an actionable Feed-health strip. Recent Cycle Runs link to detail. No greeting or reassuring headline claims everything is working.
2. A Cycle Run detail sheet shows explicitly global summary counts and your Feed attempts. Tabs separate attempts from attributed Items. Expand an attempt for its classified diagnostic, current Feed health and copyable ID. Issues sort before normal outcomes.

Feed timestamps in expanded detail describe current Feed state, not a historical snapshot of that attempt. The JSON response must keep those concepts separate. Attempt IDs copy in full even when displayed abbreviated.

Mobile uses compact navigation and stacked charts; the diagnostic sheet becomes full-screen. The board illustrates desktop only. Empty, loading, unavailable-history and error states still need design during implementation.

## Visual changes

- Cool gray page background, white cards, graphite navigation and stronger text contrast. Blue denotes actions and ingestion; violet distinguishes personal reading. Amber means an actionable warning; red means failure or automatic Deactivation. Normal Backoff and unchanged polls remain neutral.
- Increase the desktop content width to about 1200px. Pair polling and reading charts instead of stacking every panel. On mobile, replace the navigation rail with compact top navigation and stack content in priority order.
- Keep borders light. Remove most card-header dividers and uppercase KPI labels. Use stronger headings, tabular numerals, and more whitespace between sections than within related data.
- Rename the visible Metrics tab to Overview and Feed to Subscriptions. Existing URLs can stay unchanged.
- Label global and User-scoped data explicitly. The current total Item count, weekly new Item count and Cycle Run totals are global. Reads, Feed activity and poll interval distribution are User-scoped. Don't present the global Item count as the User's library.
- Move total retained Items and poll interval distribution below the primary overview, into operational detail. Keep optional Analytics Engine panels secondary and label their actual windows individually.

## Put the `next` data to work

| Data already available | Proposed presentation | Work beyond styling |
| --- | --- | --- |
| Last successful poll and last new Item discovery | Two distinct timestamps in Subscription detail. A successful unchanged poll is not stale or broken. | None in the Subscription view. |
| Deactivation reason, error count, next eligibility | Attention strip linked to affected Feeds; explain automatic versus manual Deactivation. Show normal Backoff separately. | Overview must also load the existing Subscription projection. Do not guess status by searching diagnostic text. |
| Initial backload completion and poll-state origin | Small backload status in expanded Feed detail. Preserve legacy inference and uncertainty. | None in the Subscription view. |
| Cycle Run lifecycle, checked/selected/skipped/failed counts | Compact history rows with distinct running, completed, and empty states. Checked/selected progress only while running. | Existing projections are enough; compose Overview with Timeline data for User-scoped detail. |
| Classified attempt outcomes, HTTP status, parser fallback | Expand a run to show failed and rate-limited attempts first. Keep unchanged and not-modified outcomes neutral. Copyable IDs belong in detail, not every summary row. | Accessible expansion and copy interaction. Public diagnostics stay classified; no raw stored error text. |
| Exact Item attribution | Show Items in your Subscriptions separately from global new Items. Link each Item to its discovering attempt in expanded detail. | Existing Timeline projection. |
| Expired or legacy attribution | Explicit unavailable-history notice. Never infer run membership from timestamps. | Existing Timeline projection. |
| Reads by day and Feed activity | A personal reading-week chart and compact active-Feed ranking. | Add missing zero-read dates before rendering the chart. Show date/timezone accurately. |

Avoid made-up percentage changes, a calculated "health score", or a next-poll countdown that implies guaranteed execution. Next eligibility is not a scheduled completion time. Reading charts should describe tracked read events, not reading duration.

## Shadcn component choices

The project currently uses Hono server-rendered JSX, htmx and Tailwind v4. There is no React runtime, client hydration setup, UI import alias, or `components.json`. Its styles are described as a shadcn aesthetic, but the components are handwritten.

The agreed approach is a React dashboard built with Vite and TanStack Router, using actual shadcn components. Do not migrate to TanStack Start or Astro. Do not add TanStack Query yet.

- Card and Badge for summaries and explicit outcomes.
- Chart for polling and reading visualizations. Use tooltips and accessible tabular alternatives; shadcn Chart depends on Recharts.
- Sheet for Cycle Run details; Tabs for attempts versus attributed Items; Collapsible for individual diagnostics.
- Button and Dropdown Menu for sync actions. Keep forced sync secondary.
- Table and Input for Subscription management. Sorting and filtering are dashboard behavior, not automatically supplied by installing Table.

Hono retains authentication, same-origin JSON dashboard endpoints, Feed-module calls, D1 and the existing GReader API. Dashboard data loads through route loaders and plain fetch initially. Mutation results should refresh the affected route data without requiring a new caching library. Use shared TypeScript response types and validate incoming requests on the server.

Preserve the existing authentication and security protections when replacing HTML-returning htmx mutations with JSON endpoints. No database access or Analytics Engine credentials go into the client bundle. Keep the current deployment unless build integration proves a change necessary.

This document records the selected direction, not the current runtime. Update `docs/architecture.md` and the Hono/htmx rationale in `docs/decisions.md` with the actual migration; update README if deployment steps change.

Sources checked:

- [Manual installation](https://ui.shadcn.com/docs/installation/manual)
- [Card registry source](https://ui.shadcn.com/r/styles/new-york-v4/card.json)
- [Chart registry source](https://ui.shadcn.com/r/styles/new-york-v4/chart.json)

## Linter setup

Installed `@shadcn/lint` as a root development dependency and registered it in `.oxlintrc.json` under `jsPlugins`. Existing TypeScript plugin, unused-disable policy and `lint` command are unchanged. This is a single project; `pnpm-workspace.yaml` currently contains dependency build approvals, not multiple app packages.

Node 26.8.1 and Oxlint 1.86 satisfy the documented requirements of Node 20.19+ and Oxlint 1.80+. Tailwind v4 tokens are in `src/styles.css`; no discovery overrides are needed at this stage.

Run `pnpm lint`. Configuration loads successfully. No new `@shadcn/lint` rules or presets were enabled, so passing lint does not yet enforce a design system.

Add chosen policies under `rules` in `.oxlintrc.json` after deciding which components and tokens the dashboard uses. If components move to a nonstandard location, configure discovery then rather than declaring a directory that doesn't exist.

- [Available rules](https://github.com/shadcn-ui/lint/blob/main/README.md#rules)
- [Design-system contracts and configuration examples](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md)
- [Setup instructions](https://github.com/shadcn-ui/lint/blob/main/SETUP.md)

## Remaining design feedback

- Does the blue/violet palette and graphite navigation feel sharp enough without turning the whole dashboard dark?
- Does a diagnostic side sheet provide enough space, or should detailed Cycle Runs also have a full-page view?

No prototype branch or dashboard implementation has been created. The board is a static visual proposal, not a functioning React prototype. Next implementation should use the selected stack and real components rather than treating SVG annotations as working controls.
