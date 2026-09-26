ALTER TABLE `items` ADD `source_revid` bigint unsigned;--> statement-breakpoint
ALTER TABLE `items` ADD `converter_version` int unsigned;--> statement-breakpoint
CREATE INDEX `idx_items_revision` ON `items` (`converter_version`,`qid`,`source_revid`,`primary_type`);