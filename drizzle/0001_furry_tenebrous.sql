ALTER TABLE `feeds` ADD `consecutive_errors` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `deactivated_at` integer;