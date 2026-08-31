import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, customType } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Postgres bytea as a Node Buffer.
 *
 * Drizzle has no first-class bytea type, and the vector column has to survive
 * a round trip byte for byte — a Float32Array reinterpreted through a text
 * encoding is silently wrong rather than loudly broken.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Vector index backing semantic recall (MUL-441).
 *
 * Deliberately not a pgvector column: the default deployment runs the bundled
 * embedded-postgres, which ships no `vector` extension. At this corpus size
 * (~3000 chunks) a brute-force cosine scan costs single-digit milliseconds, so
 * the extension would buy nothing and cost the zero-config install.
 */
export const recallEmbeddings = pgTable(
  "recall_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** wiki | rule | issue | document | decision | case */
    sourceKind: text("source_kind").notNull(),
    /** Polymorphic across six tables, so no foreign key. */
    sourceId: uuid("source_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    /** Offset of the chunk inside the source body, for snippet anchoring. */
    chunkOffset: integer("chunk_offset").notNull(),
    /** Skips re-embedding a chunk whose text has not changed. */
    contentHash: text("content_hash").notNull(),
    /** Part of the uniqueness key: a model switch builds a second, parallel set. */
    model: text("model").notNull(),
    dim: integer("dim").notNull(),
    /** Packed Float32Array, little-endian, `dim` entries. */
    vector: bytea("vector").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chunkUq: uniqueIndex("recall_embeddings_chunk_uq").on(
      table.companyId,
      table.model,
      table.sourceKind,
      table.sourceId,
      table.chunkIndex,
    ),
    companyModelIdx: index("recall_embeddings_company_model_idx").on(table.companyId, table.model),
    sourceIdx: index("recall_embeddings_source_idx").on(
      table.companyId,
      table.sourceKind,
      table.sourceId,
    ),
  }),
);
