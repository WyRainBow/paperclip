-- Issues are never deleted, only archived (MUL-109).
--
-- Two halves. The columns give archive a first-class state with attribution,
-- mirroring decision retention's actor triple so "who archived this and why"
-- is answerable from the row itself. The trigger is the part that actually
-- holds: a DELETE on issues raises regardless of identity, role, or code path
-- — including a psql session typing raw SQL — so no future route, CLI, or
-- migration can quietly reintroduce deletion.
--
-- Exactly two paths may still delete, and both must opt in inside their own
-- transaction with `set local paperclip.allow_issue_delete = 'on'`:
--   1. deleting an entire company (services/companies.ts), which tears down
--      every child table anyway;
--   2. a routine rolling back the issue it just created inside a failed
--      transaction (services/routines.ts), where the card never became real.
-- The setting is transaction-scoped, so it cannot leak into another statement.

ALTER TABLE "issues" ADD COLUMN "archived_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN "archived_reason" text;
ALTER TABLE "issues" ADD COLUMN "archived_by_type" text;
ALTER TABLE "issues" ADD COLUMN "archived_by_agent_id" uuid;
ALTER TABLE "issues" ADD COLUMN "archived_by_user_id" text;

ALTER TABLE "issues"
  ADD CONSTRAINT "issues_archived_by_agent_id_agents_id_fk"
  FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "issues" ADD CONSTRAINT "issues_archive_actor_check" CHECK (
  ("issues"."archived_at" IS NULL AND "issues"."archived_by_type" IS NULL AND "issues"."archived_by_agent_id" IS NULL AND "issues"."archived_by_user_id" IS NULL)
  OR ("issues"."archived_at" IS NOT NULL AND "issues"."archived_by_type" = 'system' AND "issues"."archived_by_agent_id" IS NULL AND "issues"."archived_by_user_id" IS NULL)
  OR ("issues"."archived_at" IS NOT NULL AND "issues"."archived_by_type" = 'agent' AND "issues"."archived_by_agent_id" IS NOT NULL AND "issues"."archived_by_user_id" IS NULL)
  OR ("issues"."archived_at" IS NOT NULL AND "issues"."archived_by_type" = 'user' AND "issues"."archived_by_agent_id" IS NULL AND "issues"."archived_by_user_id" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "issues_company_archived_idx" ON "issues" ("company_id", "archived_at");

CREATE OR REPLACE FUNCTION paperclip_forbid_issue_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('paperclip.allow_issue_delete', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'issues are archive-only: deleting issue % is not permitted', OLD.id
    USING ERRCODE = 'restrict_violation',
          HINT = 'Archive the issue instead (POST /api/issues/:id/archive).';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "issues_forbid_delete" ON "issues";
CREATE TRIGGER "issues_forbid_delete"
  BEFORE DELETE ON "issues"
  FOR EACH ROW EXECUTE FUNCTION paperclip_forbid_issue_delete();
