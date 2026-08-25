-- Terminal-agent decision attribution: decisions can now record which agent
-- resolved them (decided_by_agent_id) alongside the existing board user, and
-- a decision declares its resolver policy so agent-mutual decisions created
-- from terminal collaboration can be resolved by agents without a board hop.
ALTER TABLE "decisions" ADD COLUMN "decided_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "decisions" ADD COLUMN "resolver_policy" text NOT NULL DEFAULT 'board';
