import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * One row per recall search (MUL-449).
 *
 * Started as a log of searches that matched nothing. Measured against the real
 * corpus right after building it, that target was wrong: two questions built to
 * have no answer came back with 4 and 8 results, because MUL-441 widened recall
 * enough that a bigram query almost always finds something. The failure mode is
 * not "found nothing", it is "found only noise".
 *
 * Judging noise needs a score threshold, and picking that threshold needs a
 * distribution nobody has yet. So this table stores facts and judges nothing:
 * `result_count`, `top_score` and `top_coverage` go in on every search, and
 * where to draw the line stays a query against real data rather than a guess
 * baked into the write path.
 *
 * Deliberately not a phase on `workspace_asset_citations`. That table pairs
 * served with cited so the two can be divided; this one is per search, not per
 * asset, and mixing the grains would oblige every existing consumer to filter.
 */
export const recallQueries = pgTable(
  "recall_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Set null on delete: what the corpus could not answer stays true after the agent is gone. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    /** Terms the tokenizer produced. Zero means it ate the query entirely. */
    termCount: integer("term_count").notNull(),
    /**
     * Terms that survived df pruning, i.e. how much of the question the corpus
     * recognised at all. Null on rows written before this column existed.
     *
     * Its ratio to `termCount` is the honest quality signal, and coverage alone
     * is not. Measured on the real corpus: a pure-noise question scored
     * coverage 1.000 because pruning left it one generic bigram that then
     * matched perfectly, while a question with a good answer scored 0.309.
     */
    scoringTermCount: integer("scoring_term_count"),
    /** Rows SQL returned before ranking. Zero is a content gap, non-zero is a score floor. */
    candidateCount: integer("candidate_count").notNull(),
    /** False means the vector leg never ran, so this row says nothing about semantic coverage. */
    semanticUsed: boolean("semantic_used").notNull(),
    /** Results the caller received. Zero is the original miss case. */
    resultCount: integer("result_count").notNull().default(0),
    /** Best result's final score, null when there were none. */
    topScore: doublePrecision("top_score"),
    /**
     * Best result's weighted coverage. Kept beside topScore because the two
     * disagree in the informative case: a high score built from a source weight
     * or adoption boost on top of thin coverage is what a noisy hit looks like.
     */
    topCoverage: doublePrecision("top_coverage"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("recall_queries_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyResultIdx: index("recall_queries_company_result_idx").on(
      table.companyId,
      table.resultCount,
      table.createdAt,
    ),
  }),
);
