-- Queries that found nothing (MUL-449).
--
-- `workspace_asset_citations` records what happened to an asset: it was served,
-- or it was cited. A query that matched nothing has no asset to attach to, so
-- it was silently dropped — `recordServed` returns early on an empty hit list.
-- The result is that the single most useful signal about recall quality, "what
-- are agents asking that we cannot answer", did not exist anywhere.
--
-- The cost of that gap is already on the record. MUL-80 set its restart
-- condition to "a real semantic miss shows up", then waited two months until a
-- human tried eight questions by hand on 2026-08-30. Every one of those misses
-- had been happening routinely and leaving no trace.
--
-- Separate table rather than a third `phase` on the citation ledger. That table
-- exists so served and cited can be divided by each other (see its own comment);
-- a miss is neither numerator nor denominator, and adding it there would mean
-- every existing consumer has to remember to filter the new phase forever.
-- Missing one filter would silently skew adoption ranking.
--
-- The three diagnostic columns are what make a row actionable. Query text alone
-- says a search failed; these say why, and the four causes have four different
-- fixes:
--   term_count = 0        the query was tokenized into nothing (tokenizer bug)
--   candidate_count = 0   nothing in the corpus contains these terms (content gap)
--   candidate_count > 0   candidates existed but the score floor rejected them
--   semantic_used = false the vector leg did not run, so this miss says nothing
--                         about semantic coverage

CREATE TABLE IF NOT EXISTS "recall_misses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"session_id" text,
	"issue_id" uuid,
	"query" text NOT NULL,
	"term_count" integer NOT NULL,
	"candidate_count" integer NOT NULL,
	"semantic_used" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "recall_misses" ADD CONSTRAINT "recall_misses_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Agent set null rather than cascade: a miss is evidence about the corpus, and
-- it stays true after the agent that hit it is gone.
DO $$ BEGIN
 ALTER TABLE "recall_misses" ADD CONSTRAINT "recall_misses_agent_id_agents_id_fk"
   FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "recall_misses" ADD CONSTRAINT "recall_misses_issue_id_issues_id_fk"
   FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The read this table exists for: recent misses for one company, newest first.
CREATE INDEX IF NOT EXISTS "recall_misses_company_created_idx"
	ON "recall_misses" ("company_id", "created_at");
