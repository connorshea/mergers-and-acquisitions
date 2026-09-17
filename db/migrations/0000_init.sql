CREATE TABLE `entity_labels` (
	`qid` varchar(32) NOT NULL,
	`label` varchar(512) NOT NULL,
	`synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `entity_labels_qid` PRIMARY KEY(`qid`)
);
--> statement-breakpoint
CREATE TABLE `external_ids` (
	`id` int AUTO_INCREMENT NOT NULL,
	`qid` varchar(32) NOT NULL,
	`property` varchar(16) NOT NULL,
	`value` varchar(255) NOT NULL,
	CONSTRAINT `external_ids_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_external_ids_unique` UNIQUE(`qid`,`property`,`value`)
);
--> statement-breakpoint
CREATE TABLE `item_descriptions` (
	`qid` varchar(32) NOT NULL,
	`description` text NOT NULL,
	`synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `item_descriptions_qid` PRIMARY KEY(`qid`)
);
--> statement-breakpoint
CREATE TABLE `items` (
	`qid` varchar(32) NOT NULL,
	`primary_label` varchar(255),
	`primary_type` varchar(32),
	`data` json NOT NULL,
	`last_synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `items_qid` PRIMARY KEY(`qid`)
);
--> statement-breakpoint
CREATE TABLE `merge_candidates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`from_qid` varchar(32) NOT NULL,
	`into_qid` varchar(32) NOT NULL,
	`confidence` double NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`reasons` json NOT NULL,
	`has_blocker` boolean NOT NULL DEFAULT false,
	`detected_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`resolved_at` datetime,
	`resolution` varchar(255),
	CONSTRAINT `merge_candidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_merge_candidates_pair` UNIQUE(`from_qid`,`into_qid`)
);
--> statement-breakpoint
CREATE TABLE `properties` (
	`pid` varchar(16) NOT NULL,
	`label` varchar(255) NOT NULL,
	`datatype` varchar(64),
	`formatter_url` varchar(2048),
	`synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `properties_pid` PRIMARY KEY(`pid`)
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`scope` varchar(64) NOT NULL,
	`cursor` int NOT NULL DEFAULT 0,
	`last_run_at` datetime,
	CONSTRAINT `sync_state_scope` PRIMARY KEY(`scope`)
);
--> statement-breakpoint
CREATE INDEX `idx_external_ids_property_value` ON `external_ids` (`property`,`value`);--> statement-breakpoint
CREATE INDEX `idx_external_ids_qid` ON `external_ids` (`qid`);--> statement-breakpoint
CREATE INDEX `idx_items_primary_label` ON `items` (`primary_label`);--> statement-breakpoint
CREATE INDEX `idx_items_primary_type` ON `items` (`primary_type`);--> statement-breakpoint
CREATE INDEX `idx_merge_candidates_status_confidence` ON `merge_candidates` (`status`,`confidence`);