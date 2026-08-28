import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * The citation ledger for team assets (Team Rules, Team Wiki, Team Skills).
 *
 * Two phases share one table because every question worth asking divides one
 * count by the other: an asset that is served constantly and never cited is
 * dead weight in the SessionStart budget, and finding it means reading both
 * numbers together (MUL-133 decision 61891ec2, option b).
 *
 * `served` rows are written by the recall endpoint itself, so they are a
 * derived record — losing them costs a ranking signal, not a fact. `cited`
 * rows are a one-shot declaration by the agent that actually used the asset
 * and cannot be replayed from anything, so they are first-class data. Keep
 * that asymmetry in mind before pruning: `served` may be trimmed by window,
 * `cited` may not.
 *
 * `assetId` is polymorphic across three tables and therefore carries no
 * foreign key, the same shape `feedback_votes.targetId` already uses.
 * `assetVersionId` pins which revision was on screen, so a citation still
 * points at the text that was actually read after the asset is edited.
 */
export const workspaceAssetCitations = pgTable(
  "workspace_asset_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    assetKind: text("asset_kind").notNull(),
    assetId: uuid("asset_id").notNull(),
    assetVersionId: uuid("asset_version_id"),
    phase: text("phase").notNull(),
    query: text("query"),
    score: doublePrecision("score"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAssetPhaseIdx: index("workspace_asset_citations_company_asset_phase_idx").on(
      table.companyId,
      table.assetKind,
      table.assetId,
      table.phase,
    ),
    companyIssueIdx: index("workspace_asset_citations_company_issue_idx").on(table.companyId, table.issueId),
    companyCreatedIdx: index("workspace_asset_citations_company_created_idx").on(table.companyId, table.createdAt),
    // One citation per asset per issue. A session that declares the same rule
    // twice is reporting one adoption, not two, and letting it double-count
    // would let a chatty caller outvote the rest of the company.
    citedPerIssueUq: uniqueIndex("workspace_asset_citations_cited_per_issue_uq")
      .on(table.companyId, table.issueId, table.assetKind, table.assetId)
      .where(sql`phase = 'cited' and issue_id is not null`),
    assetKindCheck: check(
      "workspace_asset_citations_asset_kind_check",
      sql`${table.assetKind} in ('rule', 'wiki', 'skill')`,
    ),
    phaseCheck: check("workspace_asset_citations_phase_check", sql`${table.phase} in ('served', 'cited')`),
  }),
);
