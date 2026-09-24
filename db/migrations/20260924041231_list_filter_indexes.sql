CREATE INDEX `idx_merge_candidates_status_detected` ON `merge_candidates` (`status`,`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_merge_candidates_into` ON `merge_candidates` (`into_qid`);