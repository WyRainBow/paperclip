-- Issues: record which CLI/agent session filed the card, mirroring Multica's
-- --session navigation account. Metadata, not identity — attribution still runs
-- through created_by_user_id / created_by_agent_id and the run machinery; this
-- column only answers "which session's transcript will show this card".
ALTER TABLE "issues" ADD COLUMN "created_by_session" text;
