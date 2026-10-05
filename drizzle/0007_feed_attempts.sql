CREATE TABLE `feed_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`cycle_run_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text,
	`http_status` integer,
	`error_kind` text,
	`error_message` text,
	`parser_state` text,
	`items_added` integer,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `feed_attempts_feed_started_idx` ON `feed_attempts` (`feed_id`,`started_at`,`id`);
--> statement-breakpoint
ALTER TABLE `items` ADD `attempt_id` text;
