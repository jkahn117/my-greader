import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// Authorised users — single user in practice, but keyed for FK relationships
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique().notNull(),
  createdAt: integer("created_at").notNull(),
});

// Canonical feed registry — shared across all users.
// Each unique feed URL is fetched once regardless of subscriber count.
export const feeds = sqliteTable("feeds", {
  id: text("id").primaryKey(),
  feedUrl: text("feed_url").unique().notNull(),
  htmlUrl: text("html_url"),
  title: text("title"),
  // Retained for rollback compatibility. New polling policy does not read or write it.
  legacyLastFetchedAt: integer("last_fetched_at"),
  lastSuccessfulPollAt: integer("last_successful_poll_at"),
  lastNewItemDiscoveredAt: integer("last_new_item_discovered_at"),
  initialBackloadCompletedAt: integer("initial_backload_completed_at"),
  pollStateOrigin: text("poll_state_origin", {
    enum: ["explicit", "legacy_inferred", "legacy_uncertain"],
  })
    .notNull()
    .default("explicit"),
  nextPollAt: integer("next_poll_at"),
  etag: text("etag"), // for conditional HTTP requests
  lastModified: text("last_modified"), // for conditional HTTP requests
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  lastError: text("last_error"), // most recent error message
  deactivatedAt: integer("deactivated_at"), // NULL = active; set after threshold
  deactivationReason: text("deactivation_reason", {
    enum: [
      "manual",
      "automatic_transient",
      "automatic_permanent",
      "legacy_unknown",
    ],
  }),
  checkIntervalMinutes: integer("check_interval_minutes").notNull().default(30), // adaptive polling backoff
  // Retained for rollback compatibility. It mixed backload completion with new-Item activity.
  legacyLastNewItemAt: integer("last_new_item_at"),
  pollOwnerAttemptId: text("poll_owner_attempt_id"),
  pollLeaseExpiresAt: integer("poll_lease_expires_at"),
  pollFence: integer("poll_fence").notNull().default(0),
});

// Per-user feed subscriptions
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id),
    title: text("title"), // user's custom title; overrides feed default if set
    folder: text("folder"), // maps to GReader labels / Current currents
  },
  (t) => [unique().on(t.userId, t.feedId)],
);

// Per-cycle polling run summary. New rows use the Workflow instance ID while
// legacy rows retain their timestamp IDs and nullable lifecycle fields.
export const cycleRuns = sqliteTable("cycle_runs", {
  id: text("id").primaryKey(),
  ranAt: integer("ran_at").notNull(),
  activeFeeds: integer("active_feeds").notNull().default(0),
  dueFeeds: integer("due_feeds").notNull().default(0),
  selectedFeeds: integer("selected_feeds").notNull().default(0),
  checkedFeeds: integer("checked_feeds").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  failedFeeds: integer("failed_feeds").notNull().default(0),
  skippedFeeds: integer("skipped_feeds").notNull().default(0),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  triggerReason: text("trigger_reason", {
    enum: ["scheduled", "manual", "forced"],
  }),
  status: text("status", { enum: ["running", "completed"] }),
  outcome: text("outcome", { enum: ["completed", "empty"] }),
});

export type FeedAttemptOutcome =
  | "new_items"
  | "unchanged"
  | "not_modified"
  | "rate_limited"
  | "failed"
  | "skipped";

export type FeedAttemptErrorClass = "network" | "http" | "parse";

export type FeedAttemptParserStatus =
  | "not_attempted"
  | "success"
  | "fallback"
  | "failure";

// One logical Feed poll within a Cycle Run. Runtime retries reuse the same ID.
export const feedPollAttempts = sqliteTable("feed_poll_attempts", {
  id: text("id").primaryKey(),
  cycleRunId: text("cycle_run_id")
    .notNull()
    .references(() => cycleRuns.id),
  feedId: text("feed_id")
    .notNull()
    .references(() => feeds.id),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
  outcome: text("outcome", {
    enum: [
      "new_items",
      "unchanged",
      "not_modified",
      "rate_limited",
      "failed",
      "skipped",
    ],
  }),
  newItems: integer("new_items").notNull().default(0),
  errorClass: text("error_class", {
    enum: ["network", "http", "parse"],
  }),
  httpStatus: integer("http_status"),
  parserStatus: text("parser_status", {
    enum: ["not_attempted", "success", "fallback", "failure"],
  }),
  diagnostic: text("diagnostic"),
  ownershipFence: integer("ownership_fence"),
});

// Fetched Items are shared, not per-User. The nullable attempt reference preserves explicit
// uncertainty for Items created before durable polling history existed.
export const items = sqliteTable("items", {
  id: text("id").primaryKey(), // SHA-256 hex of guid ?? url
  feedId: text("feed_id")
    .notNull()
    .references(() => feeds.id),
  title: text("title"),
  url: text("url"),
  content: text("content"), // trimmed to 50KB before insert
  author: text("author"),
  publishedAt: integer("published_at"),
  fetchedAt: integer("fetched_at"),
  firstIngestionAttemptId: text("first_ingestion_attempt_id").references(
    () => feedPollAttempts.id,
  ),
});

// Per-user read and starred state
export const itemState = sqliteTable(
  "item_state",
  {
    itemId: text("item_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    isRead: integer("is_read").default(0),
    isStarred: integer("is_starred").default(0),
    readAt: integer("read_at"), // epoch ms when last marked read; used for reads-per-day dashboard
  },
  (t) => [primaryKey({ columns: [t.itemId, t.userId] })],
);

// API tokens used by GReader clients (e.g. Current).
// Raw token is shown once at generation — only the SHA-256 hash is stored.
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(), // human label, e.g. "Current on iPhone"
  tokenHash: text("token_hash").unique().notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"), // NULL = active
});
