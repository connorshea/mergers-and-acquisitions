CREATE TABLE `place_ancestors` (
	`qid` varchar(32) NOT NULL,
	`ancestor` varchar(32) NOT NULL,
	`country` boolean NOT NULL DEFAULT false,
	CONSTRAINT `place_ancestors_qid_ancestor_pk` PRIMARY KEY(`qid`,`ancestor`)
);
