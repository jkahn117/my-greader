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

/** Current check health of a feed, derived from persisted state.
 *  `new` = never successfully checked; `rate_limited`/`failing`/`deactivated`
 *  from the last check outcome and error streak. */
export type FeedStatus =
  | "active"
  | "new"
  | "rate_limited"
  | "failing"
  | "deactivated";

/** One subscription row in GET /app/api/feeds. */
export interface FeedListItem {
  feedId: string;
  subscriptionId: string;
  title: string | null;
  feedUrl: string;
  htmlUrl: string | null;
  folder: string | null;
  status: FeedStatus;
  /** Last check that completed successfully (200 or 304); null = never. */
  lastSuccessfulAt: number | null;
  /** Last check attempt of any outcome; null = never checked. */
  lastCheckedAt: number | null;
  /** When the feed next becomes eligible for polling; null if never checked. */
  nextCheckAt: number | null;
  /** Last check that stored new items; null = never produced items. */
  lastNewItemAt: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  checkIntervalMinutes: number;
  deactivatedAt: number | null;
  /** transient | permanent | manual; null when deactivated before reasons existed. */
  deactivatedReason: string | null;
  /** True when the feed is deactivated with no recorded reason (pre-migration state). */
  legacyUncertain: boolean;
}

/** GET /app/api/feeds — all of the user's subscriptions. */
export interface FeedsResponse {
  feeds: FeedListItem[];
  folders: string[];
  generatedAt: number;
}

/** POST /app/api/import — OPML import outcome. */
export interface ImportResponse {
  imported: number;
  duplicates: number;
  errors: string[];
}

/** POST /app/api/feeds/sync — manual sync trigger outcome. */
export interface SyncResponse {
  triggered: boolean;
  /** Feeds the run will check (due-time eligibility honored unless forced). */
  eligible: number;
  forced: boolean;
  instanceId: string;
}
