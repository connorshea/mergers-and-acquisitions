-- Read `items` for the copy below without locking its rows (REPEATABLE READ
-- would take a shared lock on every row it copies, blocking writers for the
-- length of the copy). Session-wide, so it's reset after the copy: the
-- migrator runs every pending migration on this one connection. The CREATE
-- TABLE's implicit commit starts the copy's transaction under it.
--
-- Each statement is safe to rerun: DDL commits as it goes, and the migration
-- is only recorded once all of it has succeeded. The copy only runs while
-- `items` still has the columns it reads, so a run that got as far as the
-- ALTER but wasn't recorded can still be rerun.
--
-- Old code must not be running when this applies: it writes these columns
-- (an old /different would fail once they're gone) and doesn't know about
-- `item_sync` (an item it inserts after the copy would never get a row, so
-- would never be pruned). Stop the web service and check no `import-dump-*`
-- job is running before migrating (see README, "Deploying to Toolforge").
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `item_sync` (
	`qid` varchar(32) NOT NULL,
	`last_synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_dump` varchar(32),
	`data_hash` varchar(40),
	`source_revid` bigint unsigned,
	`converter_version` int unsigned,
	`primary_type` varchar(32),
	CONSTRAINT `item_sync_qid` PRIMARY KEY(`qid`),
	INDEX `idx_item_sync_revision` (`converter_version`,`primary_type`,`qid`,`source_revid`)
);
--> statement-breakpoint
BEGIN NOT ATOMIC
	IF EXISTS (
		SELECT 1 FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items' AND COLUMN_NAME = 'converter_version'
	) THEN
		INSERT INTO `item_sync` (`qid`, `last_synced_at`, `last_dump`, `data_hash`, `source_revid`, `converter_version`, `primary_type`)
		SELECT `qid`, `last_synced_at`, `last_dump`, `data_hash`, `source_revid`, `converter_version`, `primary_type` FROM `items`
		ON DUPLICATE KEY UPDATE
			`last_synced_at` = VALUES(`last_synced_at`),
			`last_dump` = VALUES(`last_dump`),
			`data_hash` = VALUES(`data_hash`),
			`source_revid` = VALUES(`source_revid`),
			`converter_version` = VALUES(`converter_version`),
			`primary_type` = VALUES(`primary_type`);
	END IF;
END;--> statement-breakpoint
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
