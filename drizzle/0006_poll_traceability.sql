-- Add durable Cycle Run and Feed polling attempt identities without changing
-- legacy rows. Existing Items remain unattributed because the new reference is
-- nullable and this migration does not infer relationships from timestamps.

ALTER TABLE `cycle_runs` ADD `started_at` INTEGER;
ALTER TABLE `cycle_runs` ADD `completed_at` INTEGER;
ALTER TABLE `cycle_runs` ADD `trigger_reason` TEXT;
ALTER TABLE `cycle_runs` ADD `status` TEXT;

CREATE TABLE `feed_poll_attempts` (
  `id`           TEXT    NOT NULL PRIMARY KEY,
  `cycle_run_id` TEXT    NOT NULL REFERENCES `cycle_runs`(`id`),
  `feed_id`      TEXT    NOT NULL REFERENCES `feeds`(`id`),
  `started_at`   INTEGER NOT NULL,
  `completed_at` INTEGER,
  `outcome`      TEXT,
  `new_items`    INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE `items` ADD `first_ingestion_attempt_id` TEXT REFERENCES `feed_poll_attempts`(`id`);

CREATE INDEX `feed_poll_attempts_cycle_run_idx`
  ON `feed_poll_attempts` (`cycle_run_id`);
CREATE INDEX `feed_poll_attempts_feed_idx`
  ON `feed_poll_attempts` (`feed_id`);
CREATE INDEX `items_first_ingestion_attempt_idx`
  ON `items` (`first_ingestion_attempt_id`);
