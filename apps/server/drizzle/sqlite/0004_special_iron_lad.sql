CREATE TABLE `rt_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_ids` text NOT NULL,
	`session_ids` text NOT NULL,
	`viewing` text,
	`viewing_project` text,
	`reading_event_id` text,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rt_clients_seen_idx` ON `rt_clients` (`last_seen`);--> statement-breakpoint
CREATE TABLE `rt_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rt_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rt_outbox_created_idx` ON `rt_outbox` (`created_at`);--> statement-breakpoint
CREATE TABLE `vgit_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vgit_commits` (
	`sha` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`tree` text NOT NULL,
	`parents` text NOT NULL,
	`message` text NOT NULL,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vgit_commits_repo_idx` ON `vgit_commits` (`repo`);--> statement-breakpoint
CREATE TABLE `vgit_refs` (
	`repo` text NOT NULL,
	`name` text NOT NULL,
	`sha` text NOT NULL,
	PRIMARY KEY(`repo`, `name`)
);
--> statement-breakpoint
CREATE TABLE `vgit_worktrees` (
	`path` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL
);
