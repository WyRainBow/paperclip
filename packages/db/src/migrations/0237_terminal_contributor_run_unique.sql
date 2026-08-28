-- Terminal-contributor session runs are now created by the first *write* of a
-- session rather than by its first request (MUL-104). Reads used to open the
-- run early, so by the time writes arrived the reuse lookup always hit an
-- existing row and the select-then-insert in ensureTerminalContributorRun was
-- effectively never raced. With reads no longer creating it, a session's first
-- concurrent writes all miss the lookup and would each insert a row. This
-- partial unique index makes the second insert conflict instead, so the
-- ON CONFLICT DO NOTHING path can re-read the winner.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_runs_terminal_contributor_active_uniq"
  ON "heartbeat_runs" ("company_id", "agent_id")
  WHERE "invocation_source" = 'terminal_contributor' AND "status" = 'running';
