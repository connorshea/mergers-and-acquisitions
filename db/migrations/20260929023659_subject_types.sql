CREATE TABLE `class_ancestors` (
	`class` varchar(32) NOT NULL,
	`ancestor` varchar(32) NOT NULL,
	CONSTRAINT `class_ancestors_class_ancestor_pk` PRIMARY KEY(`class`,`ancestor`)
);
--> statement-breakpoint
ALTER TABLE `properties` ADD `subject_types` json;