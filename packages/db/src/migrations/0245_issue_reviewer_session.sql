-- 评审会话 (MUL-456)
--
-- A card already remembers the session that opened it and the session driving
-- it, but not the one that reviewed it. Review is the step most likely to
-- happen on a different terminal (usually Codex), which makes it the step whose
-- context is hardest to find again later, and the only one with nowhere to
-- record it.
--
-- Same three-column shape as the driving slot, and the same semantics: one
-- slot, overwritten by the most recent review rather than accumulating. A card
-- reviewed twice points at the latest pass, which is the one a reader wants;
-- the earlier rounds are still in the discussion thread.
--
-- Nullable and unset by default. "Nobody has reviewed this" is the normal
-- state of most cards and has to stay distinguishable from "reviewed by
-- someone we failed to record".

ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "reviewer_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewer_session" text,
  ADD COLUMN IF NOT EXISTS "reviewer_session_at" timestamptz;
