import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * The two Team Wiki spaces. `paperclip` is written for people (product docs,
 * conventions people follow); `agent` is written for agents to act on. Same
 * shape, different reader — so they are one table with a discriminator rather
 * than two identical tables (decision `mul20.team-wiki.space-modeling`).
 */
export const TEAM_WIKI_SPACES = ["paperclip", "agent", "personal"] as const;
export type TeamWikiSpace = (typeof TEAM_WIKI_SPACES)[number];

/**
 * Team Wiki pages: durable team knowledge authored by people and agents.
 * Distinct from the LLM Wiki plugin, which holds machine-distilled content in
 * local files and can be rebuilt from source — anything that cannot be
 * re-distilled lives here, in the database, and travels with the company.
 */
export const teamWikiPages = pgTable(
  "team_wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    space: text("space").notNull(),
    /** Slash-separated location, e.g. `runbooks/deploy`. Unique within a space. */
    path: text("path").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /**
     * 归档 (MUL-455): set to retire a page from the default listing. The row,
     * its body and its whole revision history are untouched, and unarchiving
     * clears these three columns again.
     *
     * A stale page is worse than a missing one because a reader cannot tell it
     * from a current one, and team knowledge must not be deleted — archiving is
     * the third option those two constraints leave.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: text("archived_by_user_id"),
    archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The application validates `space` too, but a check constraint means a
    // stray write from psql or a future migration cannot orphan a page into a
    // space no UI renders.
    spaceCheck: check("team_wiki_pages_space_check", sql`${table.space} in ('paperclip', 'agent')`),
    companySpacePathUq: uniqueIndex("team_wiki_pages_company_space_path_uq").on(
      table.companyId,
      table.space,
      table.path,
    ),
    companySpaceUpdatedIdx: index("team_wiki_pages_company_space_updated_idx").on(
      table.companyId,
      table.space,
      table.updatedAt,
    ),
    companyArchivedIdx: index("team_wiki_pages_company_archived_idx").on(table.companyId, table.archivedAt),
    titleSearchIdx: index("team_wiki_pages_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    bodySearchIdx: index("team_wiki_pages_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
  }),
);

/**
 * One row per saved revision, holding a full snapshot rather than a diff — the
 * same shape as `team_rule_note_versions`, so the version list, diff dialog and
 * restore path are the same code on both surfaces.
 */
export const teamWikiPageVersions = pgTable(
  "team_wiki_page_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pageId: uuid("page_id").notNull().references(() => teamWikiPages.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    /** Snapshotted so a restore can move a page back to its old location too. */
    path: text("path").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    label: text("label"),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pageRevisionUniqueIdx: uniqueIndex("team_wiki_page_versions_page_revision_idx").on(
      table.pageId,
      table.revisionNumber,
    ),
    companyPageCreatedIdx: index("team_wiki_page_versions_company_page_created_idx").on(
      table.companyId,
      table.pageId,
      table.createdAt,
    ),
  }),
);
