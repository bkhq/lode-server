CREATE TABLE `registry_manifest_signatures` (
	`package_id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`sig` text NOT NULL,
	`expires` integer,
	`expires_sig` text,
	`catalog_sha256` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `registry_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
