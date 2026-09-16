CREATE TABLE `entity_labels` (
	`qid` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`synced_at` text DEFAULT (datetime('now')) NOT NULL
);
