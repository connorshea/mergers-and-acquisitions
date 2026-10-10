CREATE TABLE `llm_reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`qid_low` varchar(32) NOT NULL,
	`qid_high` varchar(32) NOT NULL,
	`stage` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 1,
	`model` varchar(64) NOT NULL,
	`effort` varchar(16) NOT NULL,
	`prompt_version` int NOT NULL,
	`verdict` varchar(16),
	`probability` double,
	`rationale` text,
	`error` varchar(255),
	`confirms` int,
	`low_revid` bigint unsigned,
	`high_revid` bigint unsigned,
	`batch_id` varchar(64),
	`custom_id` varchar(64),
	`input_tokens` int,
	`output_tokens` int,
	`cache_creation_input_tokens` int,
	`cache_read_input_tokens` int,
	`cost_usd` double,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`completed_at` datetime,
	CONSTRAINT `llm_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_llm_reviews_pair_stage` UNIQUE(`qid_low`,`qid_high`,`stage`)
);
--> statement-breakpoint
CREATE INDEX `idx_llm_reviews_status_batch` ON `llm_reviews` (`status`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_llm_reviews_completed` ON `llm_reviews` (`completed_at`);