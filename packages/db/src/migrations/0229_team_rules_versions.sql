-- Openspace became Team Rules: the surface is the company's single shared rule
-- text, so the storage is renamed to match. Notes also gain a version history
-- (same shape as company_skill_versions: one row per revision holding a full
-- snapshot, not a diff), so a rule edit can be reviewed and rolled back.
ALTER TABLE "openspace_notes" RENAME TO "team_rule_notes";
ALTER INDEX "openspace_notes_company_idx" RENAME TO "team_rule_notes_company_idx";

CREATE TABLE "team_rule_note_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "note_id" uuid NOT NULL REFERENCES "team_rule_notes"("id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "label" text,
  "author_user_id" text,
  "author_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "team_rule_note_versions_note_revision_idx"
  ON "team_rule_note_versions" ("note_id", "revision_number");
CREATE INDEX "team_rule_note_versions_company_note_created_idx"
  ON "team_rule_note_versions" ("company_id", "note_id", "created_at");

-- Seed v1 for notes that predate versioning, so every note has a history
-- rather than an empty tab. Their current text is the only revision we know.
INSERT INTO "team_rule_note_versions" (
  "company_id", "note_id", "revision_number", "title", "body", "label",
  "author_user_id", "author_agent_id", "created_at"
)
SELECT
  "company_id", "id", 1, "title", "body", 'Initial version',
  "created_by_user_id", "created_by_agent_id", "created_at"
FROM "team_rule_notes";
