/**
 * Shared response types for the dashboard JSON API (`/app/api/*`).
 *
 * These types are the contract between the Hono handlers and the React
 * management client. They expose domain projections only — never D1
 * physical rows or credentials.
 */

/** GET /app/api/overview — summary card totals for the authenticated user. */
export interface OverviewResponse {
  /** Total subscribed feeds (includes deactivated subscriptions). */
  feedCount: number;
  /** Subscribed feeds not deactivated. */
  activeFeedCount: number;
  /** Subscribed feeds currently deactivated. */
  deactivatedFeedCount: number;
  /** Distinct retained items ingested in the past 7 elapsed days, scoped to the user's subscriptions. */
  newItemsLast7Days: number;
  /** Current read item_state rows whose latest read receipt was in the past 7 elapsed days. */
  markedReadLast7Days: number;
  /** Feeds deactivated or with a non-zero persisted error streak. */
  feedsNeedingAttention: number;
  /** IANA timezone used for day-boundary display (DISPLAY_TIMEZONE). */
  timezone: string;
  /** Server time (epoch ms) when the response was generated. */
  generatedAt: number;
}
