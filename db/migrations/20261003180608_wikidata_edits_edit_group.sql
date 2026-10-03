ALTER TABLE `wikidata_edits` ADD `edit_group` varchar(32);--> statement-breakpoint
CREATE INDEX `idx_wikidata_edits_edit_group` ON `wikidata_edits` (`edit_group`);