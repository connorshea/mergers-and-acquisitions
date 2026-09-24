ALTER TABLE `merge_candidates` ADD `from_type` varchar(32);--> statement-breakpoint
ALTER TABLE `merge_candidates` ADD `into_type` varchar(32);--> statement-breakpoint
ALTER TABLE `merge_candidates` ADD `from_label` varchar(255);--> statement-breakpoint
ALTER TABLE `merge_candidates` ADD `into_label` varchar(255);--> statement-breakpoint
CREATE INDEX `idx_merge_candidates_status_from_type` ON `merge_candidates` (`status`,`from_type`,`confidence`);--> statement-breakpoint
CREATE INDEX `idx_merge_candidates_status_into_type` ON `merge_candidates` (`status`,`into_type`,`confidence`);--> statement-breakpoint
-- Backfill the copies from items (server/candidate-item-info.ts keeps them in sync afterwards).
UPDATE `merge_candidates` c JOIN `items` i ON i.`qid` = c.`from_qid` SET c.`from_type` = i.`primary_type`, c.`from_label` = i.`primary_label`;--> statement-breakpoint
UPDATE `merge_candidates` c JOIN `items` i ON i.`qid` = c.`into_qid` SET c.`into_type` = i.`primary_type`, c.`into_label` = i.`primary_label`;
