CREATE TABLE `external_id_dupes` (
	`property` varchar(16) NOT NULL,
	`value` varchar(512) NOT NULL,
	CONSTRAINT `external_id_dupes_property_value_pk` PRIMARY KEY(`property`,`value`)
);
