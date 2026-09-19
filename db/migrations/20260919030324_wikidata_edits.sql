CREATE TABLE `wikidata_edits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`candidate_id` int,
	`action` varchar(32) NOT NULL,
	`from_qid` varchar(32) NOT NULL,
	`into_qid` varchar(32) NOT NULL,
	`params` json,
	`ok` boolean NOT NULL,
	`error_code` varchar(64),
	`error_text` text,
	`from_revid` bigint,
	`into_revid` bigint,
	`redirected` boolean,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `wikidata_edits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `merge_candidates` ADD `resolved_by` int;--> statement-breakpoint
ALTER TABLE `wikidata_edits` ADD CONSTRAINT `wikidata_edits_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_wikidata_edits_user_id` ON `wikidata_edits` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_wikidata_edits_candidate_id` ON `wikidata_edits` (`candidate_id`);