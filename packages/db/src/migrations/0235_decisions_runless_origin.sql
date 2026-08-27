-- A decision's origin run exists to derive provenance, but a terminal agent
-- holding only a standard key has no run at all — NOT NULL here meant such an
-- agent could never propose a decision (MUL-40 follow-up, user 2026-08-27).
-- The origin issue is then supplied explicitly by the create call.
ALTER TABLE "decisions" ALTER COLUMN "origin_run_id" DROP NOT NULL;
ALTER TABLE "decision_bundles" ALTER COLUMN "origin_run_id" DROP NOT NULL;
