-- Vector index for semantic recall (MUL-441).
--
-- Vectors are stored as bytea holding a packed Float32Array, not as a pgvector
-- column. The default deployment runs the bundled embedded-postgres, whose 255
-- shipped extensions include pg_trgm and fuzzystrmatch but no `vector`. Requiring
-- pgvector would force every user onto an external database and take the
-- zero-config path with it.
--
-- Nothing is lost at this size. Measured 2026-08-30 against the real corpus:
-- 285 chunks at 1024 dimensions is 1.2 MB, and a brute-force cosine scan over
-- all of them takes 0.5 ms in Node. Extrapolated to the whole company (~3000
-- chunks) that is 12 MB and about 5 ms. An ANN index would be answering a
-- question nobody is asking yet. If the corpus grows thirty-fold, the swap is
-- an index change, not a schema change.
--
-- `source_id` is polymorphic across six tables (wiki pages, rule notes, issues,
-- documents, decisions, cases) and therefore carries no foreign key, the same
-- shape `workspace_asset_citations.asset_id` already uses. Deleting a source
-- leaves an orphan row; the reindex job clears them, and a stale vector that
-- survives is invisible because ranking only looks at rows whose source it
-- fetched.
--
-- `content_hash` is what makes reindexing cheap: a chunk whose hash is unchanged
-- is not re-embedded. `model` is part of the uniqueness key rather than a plain
-- column, so switching embedding models produces a second set of vectors and
-- lets the old one keep serving until the new one is complete.

CREATE TABLE IF NOT EXISTS "recall_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_offset" integer NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"vector" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "recall_embeddings" ADD CONSTRAINT "recall_embeddings_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- One vector per chunk per model. Re-embedding the same chunk updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS "recall_embeddings_chunk_uq"
	ON "recall_embeddings" ("company_id", "model", "source_kind", "source_id", "chunk_index");
--> statement-breakpoint

-- The load-into-memory query: everything for one company and one model.
CREATE INDEX IF NOT EXISTS "recall_embeddings_company_model_idx"
	ON "recall_embeddings" ("company_id", "model");
--> statement-breakpoint

-- The reindex query: find this source's rows to compare hashes against.
CREATE INDEX IF NOT EXISTS "recall_embeddings_source_idx"
	ON "recall_embeddings" ("company_id", "source_kind", "source_id");
