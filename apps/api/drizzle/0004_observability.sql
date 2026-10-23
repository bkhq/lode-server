CREATE TABLE `registry_instance_events` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`body` text,
	`attributes` text DEFAULT '{}' NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `registry_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_registry_instance_events_pkg_at` ON `registry_instance_events` (`package_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_registry_instance_events_at` ON `registry_instance_events` (`at`);--> statement-breakpoint
CREATE TABLE `registry_instances` (
	`package_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`version` text,
	`status` text,
	`host_name` text,
	`os_type` text,
	`host_arch` text,
	`lode_version` text,
	`interval_seconds` integer,
	`attributes` text DEFAULT '{}' NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`package_id`, `instance_id`),
	FOREIGN KEY (`package_id`) REFERENCES `registry_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_registry_instances_last_seen` ON `registry_instances` (`last_seen_at`);