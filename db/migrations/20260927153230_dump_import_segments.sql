CREATE TABLE `dump_import_segments` (
	`dump` varchar(32) NOT NULL,
	`segments` int NOT NULL,
	`segment` int NOT NULL,
	`claimed_by` varchar(64),
	`claim` varchar(16),
	`claimed_at` datetime,
	`done_at` datetime,
	`matched` int,
	CONSTRAINT `dump_import_segments_dump_segments_segment_pk` PRIMARY KEY(`dump`,`segments`,`segment`)
);
