-- The citation ledger for team assets: Team Rules, Team Wiki, Team Skills (MUL-133).
--
-- Paperclip could already hand an asset to an agent but could not learn
-- anything back from it. The recall endpoint assembled a reference list and
-- sent it into the session, and that was the end of the record — so nothing
-- knew which rules were doing work and which were only spending the
-- SessionStart budget. This table is the missing half.
--
-- Both phases live in one table because every question worth asking divides
-- one count by the other. "Served a hundred times, cited never" is the profile
-- that identifies dead weight, and reading it means reading both numbers in a
-- single aggregate.
--
-- The two phases are not equally durable. A `served` row is written by the
-- recall endpoint itself, so it is a derived record: losing it costs a ranking
-- signal, not a fact, and it may be trimmed by window. A `cited` row is a
-- one-shot declaration by the agent that actually used the asset and can be
-- replayed from nothing, so it is first-class data. Do not prune it.
--
-- `asset_id` is polymorphic across three tables and therefore carries no
-- foreign key, the same shape `feedback_votes.target_id` already uses.
-- `asset_version_id` pins which revision was on screen, so a citation still
-- points at the text that was actually read after the asset is edited.

CREATE TABLE IF NOT EXISTS "workspace_asset_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid,
	"session_id" text,
	"asset_kind" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"asset_version_id" uuid,
	"phase" text NOT NULL,
	"query" text,
	"score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_asset_citations_asset_kind_check" CHECK ("workspace_asset_citations"."asset_kind" in ('rule', 'wiki', 'skill')),
	CONSTRAINT "workspace_asset_citations_phase_check" CHECK ("workspace_asset_citations"."phase" in ('served', 'cited'))
);
--> statement-breakpoint
ALTER TABLE "workspace_asset_citations" ADD CONSTRAINT "workspace_asset_citations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_asset_citations" ADD CONSTRAINT "workspace_asset_citations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_asset_citations" ADD CONSTRAINT "workspace_asset_citations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_asset_citations_company_asset_phase_idx" ON "workspace_asset_citations" USING btree ("company_id","asset_kind","asset_id","phase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_asset_citations_company_issue_idx" ON "workspace_asset_citations" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_asset_citations_company_created_idx" ON "workspace_asset_citations" USING btree ("company_id","created_at");--> statement-breakpoint
-- One citation per asset per issue. A session that declares the same rule
-- twice is reporting one adoption, not two, and letting it double-count would
-- let a chatty caller outvote the rest of the company.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_asset_citations_cited_per_issue_uq" ON "workspace_asset_citations" USING btree ("company_id","issue_id","asset_kind","asset_id") WHERE phase = 'cited' and issue_id is not null;
