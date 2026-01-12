CREATE TABLE "task_diffs" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "diff_content" text NOT NULL,
  "untracked_files" jsonb NOT NULL,
  "base_commit" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
