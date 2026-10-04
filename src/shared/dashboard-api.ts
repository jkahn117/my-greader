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

/** Reading panel: marked-read trend + top feeds, user-scoped. */
export interface ReadingPanelData {
  windowDays: number;
  /** Zero-filled per-day marked-read counts in display timezone; boundary
   *  days (oldest and today) are partial. */
  daily: { date: string; count: number }[];
  total: number;
  topFeeds: { feedId: string; title: string | null; count: number }[];
}

/** Per-feed health buckets derived from each subscribed feed's latest
 *  recorded attempt outcome. */
export interface FeedHealthData {
  /** Latest check stored new items. */
  successful: number;
  rateLimited: number;
  failed: number;
  /** Deliberately skipped (deactivated mid-cycle). */
  skipped: number;
  /** Attempt currently in progress. */
  running: number;
  /** Latest check completed with no new items (ok-0 or 304). */
  empty: number;
  /** No recorded attempt. */
  missing: number;
}

/** Latest polling-cycle lifecycle. */
export interface CycleData {
  state: "running" | "completed" | "empty" | "missing";
  ranAt: number | null;
  checkedFeeds: number | null;
}

/** One feed needing attention, linked to its detail page. */
export interface AttentionFeed {
  feedId: string;
  title: string | null;
  reason: string;
}

/** GET /app/api/overview/panels — the panels beneath the summary cards. */
export interface OverviewPanelsResponse {
  reading: ReadingPanelData;
  feedHealth: FeedHealthData;
  cycle: CycleData;
  needsAttention: AttentionFeed[];
  /** Optional Analytics Engine projection — degrades independently. */
  analyticsEngine:
    | { status: "ok"; trend30d: { day: string; newArticles: number }[] }
    | { status: "unavailable" };
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

/** GET /app/api/feeds/:feedId — current-state detail for one subscription. */
export interface FeedDetailResponse extends FeedListItem {
  /** True once the feed has completed at least one successful check —
   *  the initial ingest is done; false while it's still pending. */
  backloadComplete: boolean;
}

/** Terminal outcome of one recorded feed check; `in_progress` is derived
 *  from a missing status (row written at attempt start). */
export type AttemptStatus =
  | "ok"
  | "not_modified"
  | "rate_limited"
  | "error"
  | "skipped"
  | "in_progress";

/** One attempt row in GET /app/api/feeds/:feedId/attempts. */
export interface FeedAttempt {
  id: string;
  cycleRunId: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: AttemptStatus;
  httpStatus: number | null;
  /** http | network | parse | null */
  errorKind: string | null;
  errorMessage: string | null;
  /** success | fallback | failure | not_attempted */
  parserState: string | null;
  itemsAdded: number | null;
  /** Items durably attributed to this attempt (items.attempt_id). */
  items: { id: string; title: string | null; url: string | null }[];
}

/** GET /app/api/feeds/:feedId/attempts — paginated attempt history. */
export interface FeedAttemptsResponse {
  attempts: FeedAttempt[];
  /** Opaque cursor for the next page; null when history is exhausted. */
  nextCursor: string | null;
  /** Streaks over retained terminal checked attempts; `lowerBound` when
   *  the scan hit its bound with older rows remaining. */
  streaks: {
    problem: { count: number; lowerBound: boolean };
    rateLimited: { count: number; lowerBound: boolean };
  };
  /** Error attempts grouped by kind over the labeled window. */
  problemGroups: {
    windowDays: number;
    groups: {
      kind: string;
      count: number;
      lastAt: number;
      lastMessage: string | null;
    }[];
  };
  /** legacy = feed checked before attempt tracking; empty = never checked. */
  historyState: "ok" | "legacy" | "empty";
  retentionDays: number;
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
