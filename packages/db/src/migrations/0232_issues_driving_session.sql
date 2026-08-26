-- MUL-35: the driving session — who is working this issue right now, one slot
-- per issue, overwritten on each start/handoff. Written from `issue start`
-- alongside the working branch; distinct from created_by_session, which is
-- written once at filing time and never changes.
ALTER TABLE "issues" ADD COLUMN "driving_session" text;
ALTER TABLE "issues" ADD COLUMN "driving_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "issues" ADD COLUMN "driving_session_at" timestamptz;
