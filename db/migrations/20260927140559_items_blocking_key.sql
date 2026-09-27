ALTER TABLE `items` ADD `blocking_key` varchar(255);--> statement-breakpoint
CREATE INDEX `idx_items_blocking` ON `items` (`blocking_key`,`primary_type`,`qid`);