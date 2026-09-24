CREATE INDEX `idx_external_ids_property_value_qid` ON `external_ids` (`property`,`value`,`qid`);--> statement-breakpoint
DROP INDEX `idx_external_ids_property_value` ON `external_ids`;
