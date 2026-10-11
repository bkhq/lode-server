CREATE TABLE `registry_retired_versions` (
	`namespace_id` text NOT NULL,
	`package_slug` text NOT NULL,
	`version` text NOT NULL,
	`retired_at` text NOT NULL,
	PRIMARY KEY(`namespace_id`, `package_slug`, `version`),
	FOREIGN KEY (`namespace_id`) REFERENCES `registry_namespaces`(`id`) ON UPDATE no action ON DELETE no action
);
