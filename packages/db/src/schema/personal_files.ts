import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const personalFiles = pgTable("personal_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  currentHash: text("current_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personalFileVersions = pgTable("personal_file_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => personalFiles.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  label: text("label"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
