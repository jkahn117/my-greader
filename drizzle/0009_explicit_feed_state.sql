ALTER TABLE `feeds` ADD `last_successful_poll_at` integer;
--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_new_item_discovered_at` integer;
--> statement-breakpoint
ALTER TABLE `feeds` ADD `initial_backload_completed_at` integer;
--> statement-breakpoint
ALTER TABLE `feeds` ADD `poll_state_origin` text NOT NULL DEFAULT 'explicit';
--> statement-breakpoint
ALTER TABLE `feeds` ADD `next_poll_at` integer;
--> statement-breakpoint
ALTER TABLE `feeds` ADD `deactivation_reason` text;
--> statement-breakpoint
UPDATE `feeds`
SET `initial_backload_completed_at` = `last_new_item_at`
WHERE `last_new_item_at` IS NOT NULL;
--> statement-breakpoint
UPDATE `feeds`
SET `poll_state_origin` = CASE
  WHEN `last_new_item_at` IS NOT NULL THEN 'legacy_inferred'
  ELSE 'legacy_uncertain'
END;
--> statement-breakpoint
UPDATE `feeds`
SET `next_poll_at` = `last_fetched_at` + (`check_interval_minutes` * 60000)
WHERE `last_fetched_at` IS NOT NULL;
--> statement-breakpoint
UPDATE `feeds`
SET `deactivation_reason` = 'legacy_unknown'
WHERE `deactivated_at` IS NOT NULL;
