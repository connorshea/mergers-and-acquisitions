CREATE TABLE `sitelink_pages` (
	`wiki` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`missing` boolean NOT NULL,
	`is_redirect` boolean NOT NULL,
	`redirect_target` varchar(255),
	`redirect_fragment` varchar(255),
	`checked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `sitelink_pages_wiki_title_pk` PRIMARY KEY(`wiki`,`title`)
);
--> statement-breakpoint
CREATE INDEX `idx_sitelink_pages_checked` ON `sitelink_pages` (`checked_at`);