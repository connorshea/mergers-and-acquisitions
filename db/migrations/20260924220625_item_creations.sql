CREATE TABLE `item_creations` (
	`qid` varchar(32) NOT NULL,
	`rev_id` bigint NOT NULL,
	`created_at` datetime NOT NULL,
	`user_name` varchar(255),
	`user_id` int,
	`user_edit_count` int,
	`user_is_bot` boolean NOT NULL DEFAULT false,
	`comment` text,
	`tags` json NOT NULL,
	`checked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `item_creations_qid` PRIMARY KEY(`qid`)
);
--> statement-breakpoint
CREATE INDEX `idx_item_creations_checked` ON `item_creations` (`checked_at`);