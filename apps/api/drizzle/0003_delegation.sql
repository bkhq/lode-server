CREATE TABLE `registry_delegations` (
	`package_id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`key_id` text NOT NULL,
	`public_key` text NOT NULL,
	`not_before` integer NOT NULL,
	`not_after` integer NOT NULL,
	`issuer` text,
	`sig` text NOT NULL,
	`root_key_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `registry_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `registry_revocation_lists` (
	`package_id` text PRIMARY KEY NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked` text NOT NULL,
	`key_id` text NOT NULL,
	`delegation` text,
	`sig` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `registry_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
