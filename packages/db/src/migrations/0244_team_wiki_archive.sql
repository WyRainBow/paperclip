-- Team Wiki 归档 (MUL-455)
--
-- The wiki had no way to retire a page: you kept it or you deleted it. Team
-- knowledge cannot be deleted, so stale pages accumulated and stayed on the
-- shelf next to current ones, which is worse than having no page at all — a
-- reader cannot tell them apart. `agent/playbooks/issue-workflow` is the case
-- that forced this: it still tells agents to create decisions through the raw
-- API, and following it now skips the CLI's local template check.
--
-- Archiving hides a page from the default listing and nothing else. The row,
-- its body and its whole revision history stay exactly where they were, and
-- unarchive puts it back. Same field shape as `issues` so the two archives read
-- the same way.
--
-- Path uniqueness stays global on purpose: an archived page still owns its
-- path, so re-using it means unarchiving and editing rather than quietly
-- growing a second page at the same address that the old one shadows.

ALTER TABLE "team_wiki_pages"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "archived_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "archived_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;

-- Who archived it is only meaningful once it is archived, and exactly one of
-- the two actor slots is filled — the same one-actor rule the issues archive
-- carries, enforced here so a stray write cannot produce a page archived by
-- both a person and an agent, or by nobody.
ALTER TABLE "team_wiki_pages"
  DROP CONSTRAINT IF EXISTS "team_wiki_pages_archived_actor_check";
ALTER TABLE "team_wiki_pages"
  ADD CONSTRAINT "team_wiki_pages_archived_actor_check" CHECK (
    ("archived_at" IS NULL AND "archived_by_user_id" IS NULL AND "archived_by_agent_id" IS NULL)
    OR ("archived_at" IS NOT NULL AND "archived_by_user_id" IS NOT NULL AND "archived_by_agent_id" IS NULL)
    OR ("archived_at" IS NOT NULL AND "archived_by_user_id" IS NULL AND "archived_by_agent_id" IS NOT NULL)
  );

-- The default listing filters on this column every time, and the archive view
-- reads it across spaces, so both paths get an index rather than a scan.
CREATE INDEX IF NOT EXISTS "team_wiki_pages_company_archived_idx"
  ON "team_wiki_pages" ("company_id", "archived_at");
