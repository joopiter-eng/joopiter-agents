ALTER TABLE "chats" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "workflow_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "workflow_error" text;