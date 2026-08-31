import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Recall queries that matched nothing (MUL-449).
 *
 * Deliberately not a third phase on `workspace_asset_citations`. That table
 * pairs served with cited so the two can be divided by each other; a miss is
 * neither, and putting it there would oblige every existing consumer to filter
 * it out forever.
 *
 * The three diagnostic columns turn a row from "a search failed" into "here is
 * which of four things went wrong", and those four have four different fixes.
 * Without them this table would only relocate the manual diagnosis, not remove
 * it.
 */
export const recallMisses = pgTable(
  "recall_misses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Set null on delete: a miss stays true about the corpus after its agent is gone. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    /** Scoring terms left after tokenization. Zero means the tokenizer ate the query. */
    termCount: integer("term_count").notNull(),
    /** Rows SQL returned before ranking. Zero is a content gap, non-zero is a score floor. */
    candidateCount: integer("candidate_count").notNull(),
    /** False means the vector leg never ran, so this miss says nothing about semantic coverage. */
    semanticUsed: boolean("semantic_used").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("recall_misses_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
