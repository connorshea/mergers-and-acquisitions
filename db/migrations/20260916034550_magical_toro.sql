CREATE TABLE `properties` (
	`pid` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`datatype` text,
	`synced_at` text DEFAULT (datetime('now')) NOT NULL
);
