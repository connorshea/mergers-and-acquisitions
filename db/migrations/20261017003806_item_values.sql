CREATE TABLE `item_values` (
	`qid` varchar(32) NOT NULL,
	`property` varchar(16) NOT NULL,
	`value` varchar(32) NOT NULL,
	CONSTRAINT `item_values_qid_property_value_pk` PRIMARY KEY(`qid`,`property`,`value`)
);
--> statement-breakpoint
ALTER TABLE `item_values` ADD CONSTRAINT `item_values_qid_items_qid_fk` FOREIGN KEY (`qid`) REFERENCES `items`(`qid`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_item_values_property_value` ON `item_values` (`property`,`value`);