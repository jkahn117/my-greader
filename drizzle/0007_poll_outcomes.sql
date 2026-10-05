-- Make Cycle Run completion and every Feed attempt outcome explicit. Existing
-- rows retain nullable lifecycle detail rather than receiving inferred states.

ALTER TABLE `cycle_runs` ADD `selected_feeds` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `cycle_runs` ADD `skipped_feeds` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `cycle_runs` ADD `outcome` TEXT;

ALTER TABLE `feed_poll_attempts` ADD `error_class` TEXT;
ALTER TABLE `feed_poll_attempts` ADD `http_status` INTEGER;
ALTER TABLE `feed_poll_attempts` ADD `parser_status` TEXT;
ALTER TABLE `feed_poll_attempts` ADD `diagnostic` TEXT;
