ALTER TABLE `merge_candidates` ADD `clash_langs` text;--> statement-breakpoint
ALTER TABLE `merge_candidates` ADD `from_label_langs` text;--> statement-breakpoint
ALTER TABLE `merge_candidates` ADD `into_label_langs` text;--> statement-breakpoint
ALTER TABLE `users` ADD `languages` json;