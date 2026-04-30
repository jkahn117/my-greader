-- Migration: query performance indexes
-- Adds indexes to support the most common query patterns in stream endpoints
-- and the metrics dashboard.

-- Covers stream/contents and stream/items/ids ORDER BY + cursor pagination
CREATE INDEX IF NOT EXISTS `idx_items_feed_published` ON `items` (`feed_id`, `published_at` DESC, `id` DESC);

-- Covers purgeOldItems WHERE fetched_at < ? and the "new articles in last 7 days" dashboard query
CREATE INDEX IF NOT EXISTS `idx_items_fetched` ON `items` (`fetched_at`);

-- Covers reads-per-day dashboard query filtering on (user_id, is_read, read_at)
CREATE INDEX IF NOT EXISTS `idx_item_state_read` ON `item_state` (`user_id`, `is_read`, `read_at`);
