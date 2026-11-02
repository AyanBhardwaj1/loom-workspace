CREATE TABLE IF NOT EXISTS "rt_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_ids" text NOT NULL,
	"session_ids" text NOT NULL,
	"viewing" text,
	"viewing_project" text,
	"reading_event_id" text,
	"last_seen" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt_outbox" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rt_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"topic" text NOT NULL,
	"body" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vgit_blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vgit_commits" (
	"sha" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"tree" text NOT NULL,
	"parents" text NOT NULL,
	"message" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vgit_refs" (
	"repo" text NOT NULL,
	"name" text NOT NULL,
	"sha" text NOT NULL,
	CONSTRAINT "vgit_refs_repo_name_pk" PRIMARY KEY("repo","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vgit_worktrees" (
	"path" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt_clients_seen_idx" ON "rt_clients" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt_outbox_created_idx" ON "rt_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vgit_commits_repo_idx" ON "vgit_commits" USING btree ("repo");