-- Widen the miss log into a query log (MUL-449, decision 37dc4085).
--
-- 0241 recorded only searches that matched nothing. Measured against the real
-- corpus immediately after building it, that turned out to be the wrong target:
-- two questions constructed to have no answer ("量子隧穿效应在低温超导里的表现",
-- "宇宙背景辐射的各向异性怎么测") returned 4 and 8 results. MUL-441 widened
-- recall enough that a bigram query almost always finds something, so the
-- failure mode moved from "found nothing" to "found only noise".
--
-- Judging noise needs a score threshold, and choosing that threshold needs a
-- distribution that does not exist yet. Storing `result_count` and `top_score`
-- on every search breaks that circle: the facts go in now, and where to draw
-- the line becomes a query against real data later instead of a guess today.
--
-- Renamed rather than kept as `recall_misses` because the table now holds
-- successful searches too, and a table named for one of its cases misleads
-- whoever reads it next. It is renamed now because it has no consumers yet —
-- this is the cheapest this change will ever be.

ALTER TABLE "recall_misses" RENAME TO "recall_queries";
--> statement-breakpoint

ALTER INDEX IF EXISTS "recall_misses_company_created_idx" RENAME TO "recall_queries_company_created_idx";
--> statement-breakpoint

-- How many results the caller actually received. Zero is the old miss case.
ALTER TABLE "recall_queries" ADD COLUMN IF NOT EXISTS "result_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Score of the best result, null when there were none. This is the column the
-- eventual "was this any good" question gets answered from; nothing judges it
-- yet, on purpose.
ALTER TABLE "recall_queries" ADD COLUMN IF NOT EXISTS "top_score" double precision;
--> statement-breakpoint

-- Coverage of the best result, i.e. how much of the query's weighted terms it
-- matched. Kept beside top_score because the two disagree in the informative
-- case: a high score from a source weight or adoption boost on top of thin
-- coverage is exactly what a noisy hit looks like.
ALTER TABLE "recall_queries" ADD COLUMN IF NOT EXISTS "top_coverage" double precision;
--> statement-breakpoint

-- The read this table exists for, once there is enough data: recent searches
-- that returned little or nothing, worst first.
CREATE INDEX IF NOT EXISTS "recall_queries_company_result_idx"
	ON "recall_queries" ("company_id", "result_count", "created_at");
