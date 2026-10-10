-- Read `items` for the copy below without locking its rows (REPEATABLE READ
-- would take a shared lock on every row it copies, blocking writers for the
-- length of the copy). Session-wide, so it's reset after the copy: the
-- migrator runs every pending migration on this one connection. The CREATE
-- TABLE's implicit commit starts the copy's transaction under it.
--
-- Each statement is safe to rerun: DDL commits as it goes, and the migration
-- is only recorded once all of it has succeeded.
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `item_sync` (
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
SELECT `qid`, `last_synced_at`, `last_dump`, `data_hash`, `source_revid`, `converter_version` FROM `items`
ON DUPLICATE KEY UPDATE
	`last_synced_at` = VALUES(`last_synced_at`),
	`last_dump` = VALUES(`last_dump`),
	`data_hash` = VALUES(`data_hash`),
	`source_revid` = VALUES(`source_revid`),
	`converter_version` = VALUES(`converter_version`);--> statement-breakpoint
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;--> statement-breakpoint
-- One ALTER, so `items` (11+ GB) waits for its metadata lock once, and the
-- drops land together or not at all.
ALTER TABLE `items`
	DROP INDEX IF EXISTS `idx_items_last_dump`,
	DROP INDEX IF EXISTS `idx_items_revision`,
	DROP COLUMN IF EXISTS `last_synced_at`,
	DROP COLUMN IF EXISTS `last_dump`,
	DROP COLUMN IF EXISTS `data_hash`,
	DROP COLUMN IF EXISTS `source_revid`,
	DROP COLUMN IF EXISTS `converter_version`;
