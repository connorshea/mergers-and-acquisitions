CREATE TABLE `item_descriptions` (
	`qid` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`synced_at` text DEFAULT (datetime('now')) NOT NULL
);
