-- Personal directive files fold into the team-wiki engine (user 2026-08-26):
-- markdown + revision chain + diff via the same machinery, third space
-- 'personal'. The dedicated personal_files tables are migrated then dropped;
-- the check-in CLI now writes wiki pages instead.
ALTER TABLE "team_wiki_pages" DROP CONSTRAINT "team_wiki_pages_space_check";
ALTER TABLE "team_wiki_pages" ADD CONSTRAINT "team_wiki_pages_space_check" CHECK ("space" IN ('paperclip', 'agent', 'personal'));

-- One wiki page per registered file: path = kind, title = filesystem path,
-- body = latest checked-in content.
INSERT INTO "team_wiki_pages" ("company_id", "space", "path", "title", "body", "created_by_user_id")
SELECT f."company_id", 'personal', f."kind", f."path",
       COALESCE((SELECT v."content" FROM "personal_file_versions" v WHERE v."file_id" = f."id" ORDER BY v."revision_number" DESC LIMIT 1), ''),
       f."user_id"
FROM "personal_files" f
ON CONFLICT DO NOTHING;

INSERT INTO "team_wiki_page_versions" ("company_id", "page_id", "revision_number", "path", "title", "body", "label", "author_user_id")
SELECT p."company_id", p."id", 1, p."path", p."title", p."body", '迁入（原 personal_files 快照）', p."created_by_user_id"
FROM "team_wiki_pages" p WHERE p."space" = 'personal';

DROP TABLE "personal_file_versions";
DROP TABLE "personal_files";
