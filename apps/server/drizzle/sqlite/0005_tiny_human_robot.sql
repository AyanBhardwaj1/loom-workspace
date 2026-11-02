CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tokens_hash_idx` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `external_work` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent` text NOT NULL,
	`branch` text NOT NULL,
	`files` text NOT NULL,
	`summary` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `external_work_project_idx` ON `external_work` (`project_id`);