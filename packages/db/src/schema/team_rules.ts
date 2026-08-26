import { index, integer, pgTable, text, timestamp, doublePrecision, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Team Rules: the company's shared rule text that every agent and person works
 * from. Notes are the only Team Rules-owned storage — skills and the wiki are
 * referenced from the tab, never copied.
 */
export const teamRuleNotes = pgTable(
  "team_rule_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    position: doublePrecision("position").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("team_rule_notes_company_idx").on(table.companyId, table.position, table.createdAt),
  }),
);

/**
 * One row per saved revision, holding a full snapshot of the note's title and
 * body rather than a diff — the same shape as `company_skill_versions`, so the
 * history stays readable even if an older revision's ancestors are pruned.
 */
export const teamRuleNoteVersions = pgTable(
  "team_rule_note_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull().references(() => teamRuleNotes.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    label: text("label"),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    noteRevisionUniqueIdx: uniqueIndex("team_rule_note_versions_note_revision_idx").on(
      table.noteId,
      table.revisionNumber,
    ),
    companyNoteCreatedIdx: index("team_rule_note_versions_company_note_created_idx").on(
      table.companyId,
      table.noteId,
      table.createdAt,
    ),
  }),
);
