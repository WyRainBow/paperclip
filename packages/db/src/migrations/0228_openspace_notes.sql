-- Openspace: company-level shared context notes. The openspace tab holds
-- public content (markdown notes) and reference-style links into skills and
-- the wiki; notes are the only new storage.
CREATE TABLE "openspace_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "position" double precision NOT NULL DEFAULT 0,
  "created_by_user_id" text,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "openspace_notes_company_idx" ON "openspace_notes" ("company_id", "position", "created_at");
