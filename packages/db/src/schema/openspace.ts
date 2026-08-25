import { index, pgTable, text, timestamp, doublePrecision, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Openspace notes: company-level shared context. The openspace tab renders
 * these alongside reference links into company skills and the wiki; notes are
 * the only openspace-owned storage (everything else is linked, not copied).
 */
export const openspaceNotes = pgTable(
  "openspace_notes",
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
    companyIdx: index("openspace_notes_company_idx").on(table.companyId, table.position, table.createdAt),
  }),
);
