-- Team Wiki: durable team knowledge authored by people and agents, split into
-- two spaces by reader. Distinct from the LLM Wiki plugin, which holds
-- machine-distilled content in local files and can be rebuilt from source.
--
-- One table with a `space` discriminator rather than a table per space: the two
-- spaces have identical fields and differ only in who reads them, so separate
-- tables would duplicate every read/write path for no isolation
-- (decision `mul20.team-wiki.space-modeling`).
CREATE TABLE "team_wiki_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "space" text NOT NULL,
  "path" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "created_by_user_id" text,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_wiki_pages_space_check" CHECK ("space" IN ('paperclip', 'agent'))
);

CREATE UNIQUE INDEX "team_wiki_pages_company_space_path_uq"
  ON "team_wiki_pages" ("company_id", "space", "path");
CREATE INDEX "team_wiki_pages_company_space_updated_idx"
  ON "team_wiki_pages" ("company_id", "space", "updated_at");

-- Title and body search. pg_trgm is already relied on by the issues table, so
-- the extension is present; guard anyway so a fresh database can run this.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "team_wiki_pages_title_search_idx"
  ON "team_wiki_pages" USING gin ("title" gin_trgm_ops);
CREATE INDEX "team_wiki_pages_body_search_idx"
  ON "team_wiki_pages" USING gin ("body" gin_trgm_ops);

-- Full snapshot per revision, same shape as team_rule_note_versions so the
-- version list, diff and restore are the same code on both surfaces. `path` is
-- snapshotted too, so restoring an old revision can move the page back.
CREATE TABLE "team_wiki_page_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "page_id" uuid NOT NULL REFERENCES "team_wiki_pages"("id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "path" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "label" text,
  "author_user_id" text,
  "author_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "team_wiki_page_versions_page_revision_idx"
  ON "team_wiki_page_versions" ("page_id", "revision_number");
CREATE INDEX "team_wiki_page_versions_company_page_created_idx"
  ON "team_wiki_page_versions" ("company_id", "page_id", "created_at");
