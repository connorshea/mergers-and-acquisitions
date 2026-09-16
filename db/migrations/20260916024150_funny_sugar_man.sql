CREATE TABLE `external_ids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`qid` text NOT NULL,
	`property` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_external_ids_property_value` ON `external_ids` (`property`,`value`);--> statement-breakpoint
CREATE INDEX `idx_external_ids_qid` ON `external_ids` (`qid`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_ids_unique` ON `external_ids` (`qid`,`property`,`value`);--> statement-breakpoint
CREATE TABLE `items` (
	`qid` text PRIMARY KEY NOT NULL,
	`primary_label` text,
	`primary_type` text,
	`data` text NOT NULL,
	`last_synced_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_items_primary_label` ON `items` (`primary_label`);--> statement-breakpoint
CREATE INDEX `idx_items_primary_type` ON `items` (`primary_type`);--> statement-breakpoint
CREATE TABLE `merge_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_qid` text NOT NULL,
	`into_qid` text NOT NULL,
	`confidence` real NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`has_blocker` integer DEFAULT false NOT NULL,
	`detected_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved_at` text,
	`resolution` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_candidates_pair` ON `merge_candidates` (`from_qid`,`into_qid`);--> statement-breakpoint
CREATE INDEX `idx_merge_candidates_status_confidence` ON `merge_candidates` (`status`,`confidence`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`scope` text PRIMARY KEY NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`last_run_at` text
);
