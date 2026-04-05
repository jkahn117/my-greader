import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

// Authorised users — single user in practice, but keyed for FK relationships
export const users = sqliteTable('users', {
  id:        text('id').primaryKey(),
  email:     text('email').unique().notNull(),
  createdAt: integer('created_at').notNull(),
})

// Canonical feed registry — shared across all users.
// Each unique feed URL is fetched once regardless of subscriber count.
export const feeds = sqliteTable('feeds', {
  id:                text('id').primaryKey(),
  feedUrl:           text('feed_url').unique().notNull(),
  htmlUrl:           text('html_url'),
  title:             text('title'),
  lastFetchedAt:     integer('last_fetched_at'),
  etag:              text('etag'),            // for conditional HTTP requests
  lastModified:      text('last_modified'),   // for conditional HTTP requests
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  lastError:         text('last_error'),      // most recent error message
  deactivatedAt:     integer('deactivated_at'), // NULL = active; set after threshold
})

// Per-user feed subscriptions
export const subscriptions = sqliteTable('subscriptions', {
  id:     text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  feedId: text('feed_id').notNull().references(() => feeds.id),
  title:  text('title'),   // user's custom title; overrides feed default if set
  folder: text('folder'),  // maps to GReader labels / Current currents
}, (t) => [unique().on(t.userId, t.feedId)])

// Fetched articles — shared, not per-user
export const items = sqliteTable('items', {
  id:          text('id').primaryKey(), // SHA-256 hex of guid ?? url
  feedId:      text('feed_id').notNull().references(() => feeds.id),
  title:       text('title'),
  url:         text('url'),
  content:     text('content'),  // trimmed to 50KB before insert
  author:      text('author'),
  publishedAt: integer('published_at'),
  fetchedAt:   integer('fetched_at'),
})

// Per-user read and starred state
export const itemState = sqliteTable('item_state', {
  itemId:    text('item_id').notNull(),
  userId:    text('user_id').notNull().references(() => users.id),
  isRead:    integer('is_read').default(0),
  isStarred: integer('is_starred').default(0),
}, (t) => [primaryKey({ columns: [t.itemId, t.userId] })])

// API tokens used by GReader clients (e.g. Current).
// Raw token is shown once at generation — only the SHA-256 hash is stored.
export const apiTokens = sqliteTable('api_tokens', {
  id:         text('id').primaryKey(),
  userId:     text('user_id').notNull().references(() => users.id),
  name:       text('name').notNull(),        // human label, e.g. "Current on iPhone"
  tokenHash:  text('token_hash').unique().notNull(),
  createdAt:  integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt:  integer('revoked_at'),         // NULL = active
})
