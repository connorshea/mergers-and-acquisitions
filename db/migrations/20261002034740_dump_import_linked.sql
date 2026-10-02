CREATE TABLE `dump_import_linked` (
	`dump` varchar(32) NOT NULL,
	`segments` int NOT NULL,
	`sources` varchar(1024) NOT NULL,
	`qids` mediumtext NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `dump_import_linked_dump_segments_pk` PRIMARY KEY(`dump`,`segments`)
);
