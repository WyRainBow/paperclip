-- Personal directive files (global CLAUDE.md / AGENTS.md and per-repo
-- variants) registered for version management. The files stay in the
-- filesystem as the source of truth; Paperclip only registers them and
-- snapshots content on sync (check-in model, decision in MUL-39's
-- tech-proposal). Rollback never writes back — versions export only.
CREATE TABLE "personal_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "path" text NOT NULL,
  "current_hash" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_files_owner_path_uq" UNIQUE ("company_id", "user_id", "path")
);

CREATE TABLE "personal_file_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "file_id" uuid NOT NULL REFERENCES "personal_files"("id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "label" text,
  "created_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_file_versions_file_rev_uq" UNIQUE ("file_id", "revision_number")
);
