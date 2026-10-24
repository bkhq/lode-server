CREATE TABLE `registry_commits` (
	`package_id` text NOT NULL,
	`id` text NOT NULL,
	`parent` text,
	`generation` integer NOT NULL,
	`created` text NOT NULL,
	`key_id` text NOT NULL,
	`manifest` text NOT NULL,
	`summary` text NOT NULL,
	`uploaded_at` text NOT NULL,
	PRIMARY KEY(`package_id`, `id`),
	FOREIGN KEY (`package_id`) REFERENCES `registry_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_registry_commits_pkg_generation` ON `registry_commits` (`package_id`,`generation`);--> statement-breakpoint
ALTER TABLE `registry_assets` ADD `runtime` text;--> statement-breakpoint
ALTER TABLE `registry_uploads` ADD `runtime` text;