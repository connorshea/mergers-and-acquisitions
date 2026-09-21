CREATE TABLE `dump_import_runs` (
	`dump` varchar(32) NOT NULL,
	`shard` int NOT NULL,
	`shards` int NOT NULL,
	`matched` int NOT NULL,
	`finished_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `dump_import_runs_dump_shard_pk` PRIMARY KEY(`dump`,`shard`)
);
--> statement-breakpoint
ALTER TABLE `items` ADD `last_dump` varchar(32);