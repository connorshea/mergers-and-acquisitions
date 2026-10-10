-- Read `items` for the copy below without locking its rows (REPEATABLE READ
-- would take a shared lock on every row it copies, blocking writers for the
-- length of the copy). Session-wide; the CREATE TABLE's implicit commit starts
-- the copy's transaction under it.
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;--> statement-breakpoint
CREATE TABLE `item_sync` (
	`qid` varchar(32) NOT NULL,
	`last_synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_dump` varchar(32),
	`data_hash` varchar(40),
	`source_revid` bigint unsigned,
	`converter_version` int unsigned,
	CONSTRAINT `item_sync_qid` PRIMARY KEY(`qid`)
);
--> statement-breakpoint
INSERT INTO `item_sync` (`qid`, `last_synced_at`, `last_dump`, `data_hash`, `source_revid`, `converter_version`)
SELECT `qid`, `last_synced_at`, `last_dump`, `data_hash`, `source_revid`, `converter_version` FROM `items`;--> statement-breakpoint
DROP INDEX `idx_items_last_dump` ON `items`;--> statement-breakpoint
DROP INDEX `idx_items_revision` ON `items`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `last_synced_at`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `last_dump`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `data_hash`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `source_revid`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `converter_version`;