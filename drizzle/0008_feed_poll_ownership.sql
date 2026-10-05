-- Coordinate polling across Cycle Runs with a bounded per-Feed lease and a
-- monotonic fencing token. Existing Feeds start unowned.

ALTER TABLE `feeds` ADD `poll_owner_attempt_id` TEXT;
ALTER TABLE `feeds` ADD `poll_lease_expires_at` INTEGER;
ALTER TABLE `feeds` ADD `poll_fence` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `feed_poll_attempts` ADD `ownership_fence` INTEGER;
