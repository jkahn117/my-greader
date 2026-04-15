-- Migration: observability infrastructure
-- Adds cycle_runs table for the metrics dashboard (replaces Analytics Engine
-- cycle queries) and read_at timestamp to item_state for reads-per-day tracking.

-- Per-cycle polling run summary, written by FeedPollingWorkflow
CREATE TABLE IF NOT EXISTS `cycle_runs` (
  `id`            TEXT    NOT NULL PRIMARY KEY,
  `ran_at`        INTEGER NOT NULL,
  `active_feeds`  INTEGER NOT NULL DEFAULT 0,
  `due_feeds`     INTEGER NOT NULL DEFAULT 0,
  `checked_feeds` INTEGER NOT NULL DEFAULT 0,
  `new_items`     INTEGER NOT NULL DEFAULT 0,
  `failed_feeds`  INTEGER NOT NULL DEFAULT 0
);

-- Timestamp when an item was last marked read (NULL for pre-migration reads)
ALTER TABLE `item_state` ADD `read_at` INTEGER;
