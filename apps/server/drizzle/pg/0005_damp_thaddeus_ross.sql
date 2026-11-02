CREATE TABLE IF NOT EXISTS "agent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_work" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent" text NOT NULL,
	"branch" text NOT NULL,
	"files" text NOT NULL,
	"summary" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tokens_hash_idx" ON "agent_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_work_project_idx" ON "external_work" USING btree ("project_id");