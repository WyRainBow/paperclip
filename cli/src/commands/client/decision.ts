import type { Command } from "commander";
import { addCommonClientOptions, apiPath, assertDecisionBodyTemplate, handleCommandError, printOutput, resolveCommandContext, type BaseClientOptions } from "./common.js";
import { readFile } from "node:fs/promises";

interface DecisionOptionRow { id: string; label: string; description?: string | null; recommendedByAgentId?: string | null; recommendationReason?: string | null }
interface DecisionRow {
  id: string; title: string; status: string; resolverPolicy?: string | null; ruleKey?: string | null;
  originAgentId?: string | null; originIssueId?: string | null; chosenOptionId?: string | null;
  decidedByAgentId?: string | null; decidedByUserId?: string | null; decidedAt?: string | null; createdAt?: string | null;
  body?: string; options?: DecisionOptionRow[]; inputValues?: Record<string, string> | null;
}

interface DecisionListOptions extends BaseClientOptions { status?: string; originIssue?: string; limit?: string }
interface DecisionDecideOptions extends BaseClientOptions { option: string; rationale: string; constraints?: string }
interface DecisionCreateOptions extends BaseClientOptions { payloadFile: string; originIssue: string; ruleKey?: string; resolver?: string; rationale?: string; decide?: string; constraints?: string; createdByAgent?: string }

function shortLine(d: DecisionRow): string {
  const who = d.decidedByAgentId ? `agent:${d.decidedByAgentId.slice(0, 8)}` : d.decidedByUserId ?? "";
  const verdict = d.status === "decided" ? ` → ${d.chosenOptionId}${who ? ` by ${who}` : ""}` : "";
  return `${d.id.slice(0, 8)}  ${d.status.padEnd(9)} ${d.title}${verdict}`;
}

export function registerDecisionCommands(program: Command): void {
  const decision = program.command("decision").description("Decision record operations (list / get / decide)");

  addCommonClientOptions(
    decision
      .command("list")
      .description("List decisions for a company")
      .option("--status <status>", "open | decided | expired | cancelled")
      .option("--origin-issue <idOrIdentifier>", "Only decisions raised on this issue")
      .option("--limit <n>", "Max rows (default 50)")
      .action(async (opts: DecisionListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.limit) params.set("limit", opts.limit);
          if (opts.originIssue) {
            // Accept MUL-12 style identifiers, not just UUIDs: resolve through
            // the issue endpoint the rest of the CLI already uses.
            const issue = await ctx.api.get<{ id: string }>(apiPath`/api/issues/${opts.originIssue}`);
            if (!issue?.id) throw new Error(`Issue not found: ${opts.originIssue}`);
            params.set("originIssueId", issue.id);
          }
          const base = apiPath`/api/companies/${ctx.companyId}/decisions`;
          const rows = (await ctx.api.get<DecisionRow[]>(`${base}?${params}`)) ?? [];
          if (ctx.json) return printOutput(rows, { json: true });
          console.error(`${rows.length} 条决策`);
          for (const row of rows) console.log(shortLine(row));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );


  addCommonClientOptions(
    decision
      .command("create")
      .description("Create a decision from a payload file. Flags-based sibling: `issue decision:create` — same server contract, pick by input shape")
      .requiredOption("--payload-file <path>", "JSON with title/body/options (effects auto-filled; decidedOptionId honoured with --rationale)")
      .requiredOption("--origin-issue <idOrIdentifier>", "Issue this decision was raised on")
      .option("--rule-key <key>", "Idempotent rule key")
      .option("--resolver <policy>", "board | agents", "board")
      .option("--rationale <text>", "Decide immediately with this 裁决理由 (uses payload decidedOptionId unless --decide given)")
      .option("--decide <optionId>", "Option to choose when deciding immediately")
      .option("--constraints <text>", "附加约束 for the immediate decide")
      .option("--created-by-agent <nameOrId>", "Board path only: agent the record is attributed to (defaults to $PAPERCLIP_AGENT_ID)")
      .action(async (opts: DecisionCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = JSON.parse(await readFile(opts.payloadFile, "utf8")) as {
            title: string; body: string; decidedOptionId?: string;
            options: Array<DecisionOptionRow & { effects?: unknown[]; style?: string }>;
          };
          assertDecisionBodyTemplate(payload.body);
          const issue = await ctx.api.get<{ id: string }>(apiPath`/api/issues/${opts.originIssue}`);
          if (!issue?.id) throw new Error(`Issue not found: ${opts.originIssue}`);
          const options = payload.options.map((option) => ({ ...option, effects: option.effects ?? [] }));
          // Board shells hold no agent identity, so the server's board path
          // wants createdByAgentId naming the agent the record belongs to.
          // Peer review caught this command only working over the agent-key
          // channel; resolve the attribution here so both channels work.
          const me = await ctx.api.get<{ id: string } | null>("/api/agents/me").catch(() => null);
          const createdByAgentId = me?.id
            ? null
            : (opts.createdByAgent?.trim() || process.env.PAPERCLIP_AGENT_ID?.trim() || null);
          if (!me?.id && !createdByAgentId) {
            throw new Error("no identity for the decision — authenticate with an agent key, pass --created-by-agent, or set PAPERCLIP_AGENT_ID");
          }
          const created = (await ctx.api.post<DecisionRow>(apiPath`/api/companies/${ctx.companyId}/decisions`, {
            title: payload.title, body: payload.body, options,
            resolverPolicy: opts.resolver, originIssueId: issue.id,
            ...(createdByAgentId ? { createdByAgentId } : {}),
            ...(opts.ruleKey ? { ruleKey: opts.ruleKey, idempotencyKey: `decision:${opts.ruleKey}` } : {}),
          }))!;
          let decided: DecisionRow | null = null;
          const chosen = opts.decide ?? payload.decidedOptionId;
          if (opts.rationale && chosen) {
            const inputValues: Record<string, string> = { rationale: opts.rationale };
            if (opts.constraints) inputValues.constraints = opts.constraints;
            decided = (await ctx.api.post<DecisionRow>(apiPath`/api/decisions/${created.id}/decide`, {
              optionId: chosen, inputValues,
              // Board verdicts still name the terminal that performed them.
              ...(createdByAgentId ? { actingAgentId: createdByAgentId } : {}),
            })) ?? null;
          }
          const final = decided ?? created;
          printOutput(ctx.json ? final : { id: final.id, status: final.status, chosen: final.chosenOptionId ?? null }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    decision
      .command("get")
      .description("Get one decision by UUID (8-char prefix accepted)")
      .argument("<decisionId>", "Decision UUID or unique prefix")
      .action(async (decisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          let id = decisionId;
          if (id.length < 36) {
            // Prefix lookup: the UI shows decision:<8 chars>, so the CLI must
            // accept exactly what a reader can copy from the card.
            const base = apiPath`/api/companies/${ctx.companyId}/decisions`;
            const rows = (await ctx.api.get<DecisionRow[]>(`${base}?limit=100`)) ?? [];
            const hits = rows.filter((row) => row.id.startsWith(id));
            if (hits.length === 0) throw new Error(`No decision starts with ${id}`);
            if (hits.length > 1) throw new Error(`Ambiguous prefix ${id}: ${hits.map((h) => h.id.slice(0, 12)).join(", ")}`);
            id = hits[0].id;
          }
          const row = (await ctx.api.get<DecisionRow>(apiPath`/api/decisions/${id}`))!;
          if (ctx.json) return printOutput(row, { json: true });
          console.log(shortLine(row));
          if (row.ruleKey) console.log(`ruleKey: ${row.ruleKey}`);
          for (const option of row.options ?? []) {
            const chosen = option.id === row.chosenOptionId ? "✓" : " ";
            console.log(`  [${chosen}] ${option.id} — ${option.label}`);
          }
          const rationale = row.inputValues?.rationale;
          if (rationale) console.log(`裁决理由: ${rationale}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    decision
      .command("decide")
      .description("Decide an open decision (agents may decide any policy since 2026-08-27)")
      .argument("<decisionId>", "Decision UUID or unique prefix")
      .requiredOption("--option <optionId>", "Chosen option id")
      .requiredOption("--rationale <text>", "最后裁决理由（写进决策历史）")
      .option("--constraints <text>", "附加约束")
      .action(async (decisionId: string, opts: DecisionDecideOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          let id = decisionId;
          if (id.length < 36) {
            const base = apiPath`/api/companies/${ctx.companyId}/decisions`;
            const rows = (await ctx.api.get<DecisionRow[]>(`${base}?status=open&limit=100`)) ?? [];
            const hits = rows.filter((row) => row.id.startsWith(id));
            if (hits.length !== 1) throw new Error(hits.length === 0 ? `No open decision starts with ${id}` : `Ambiguous prefix ${id}`);
            id = hits[0].id;
          }
          const inputValues: Record<string, string> = { rationale: opts.rationale };
          if (opts.constraints) inputValues.constraints = opts.constraints;
          const row = (await ctx.api.post<DecisionRow>(apiPath`/api/decisions/${id}/decide`, { optionId: opts.option, inputValues }))!;
          printOutput(ctx.json ? row : { id: row.id, status: row.status, chosen: row.chosenOptionId, decidedByAgentId: row.decidedByAgentId, decidedByUserId: row.decidedByUserId }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    decision
      .command("delete")
      .description("Delete a decision record permanently. Board deletes any; an agent only its own non-open decisions (cancel first)")
      .argument("<decisionId>", "Decision UUID or unique prefix")
      .action(async (decisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          let id = decisionId;
          if (id.length < 36) {
            const base = apiPath`/api/companies/${ctx.companyId}/decisions`;
            const rows = (await ctx.api.get<DecisionRow[]>(`${base}?limit=100`)) ?? [];
            const hits = rows.filter((row) => row.id.startsWith(id));
            if (hits.length !== 1) throw new Error(hits.length === 0 ? `No decision starts with ${id}` : `Ambiguous prefix ${id}: ${hits.map((h) => h.id.slice(0, 12)).join(", ")}`);
            id = hits[0].id;
          }
          const result = await ctx.api.delete<{ id: string; deleted: boolean }>(apiPath`/api/decisions/${id}`);
          printOutput(result, { json: ctx.json, label: ctx.json ? undefined : "deleted" });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
