import type { Command } from "commander";
import { readFile as fsReadFile } from "node:fs/promises";
import { addCommonClientOptions, apiPath, assertDecisionBodyTemplate, handleCommandError, printOutput, resolveCommandContext, type BaseClientOptions } from "./common.js";

interface DecisionOptionRow { id: string; label: string; description?: string | null; recommendedByAgentId?: string | null; recommendationReason?: string | null }
interface DecisionRow {
  id: string; title: string; status: string; resolverPolicy?: string | null; ruleKey?: string | null;
  originAgentId?: string | null; originIssueId?: string | null; chosenOptionId?: string | null;
  decidedByAgentId?: string | null; decidedByUserId?: string | null; decidedAt?: string | null; createdAt?: string | null;
  body?: string; options?: DecisionOptionRow[]; inputValues?: Record<string, string> | null;
}

interface DecisionListOptions extends BaseClientOptions { status?: string; originIssue?: string; limit?: string }
interface DecisionDecideOptions extends BaseClientOptions { option: string; rationale: string; constraints?: string; actingAgentId?: string }
interface DecisionCreateOptions extends BaseClientOptions {
  originIssue: string;
  title: string;
  body: string;
  option: string[];
  recommend: string;
  recommendReason: string;
  ruleKey?: string;
  resolver?: string;
  rationale?: string;
  decide?: string;
  constraints?: string;
  fullBodyFile?: string;
  createdByAgent?: string;
}

function parseDecisionOption(spec: string): { id: string; label: string } {
  const [id, ...rest] = spec.split("|");
  const label = rest.join("|").trim();
  if (!id?.trim() || !label) throw new Error(`--option must look like "<id>|<label>", got: ${spec}`);
  return { id: id.trim(), label };
}

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
      .description("Create a decision. A recommended option with its reason is mandatory")
      .requiredOption("--origin-issue <idOrIdentifier>", "Issue this decision was raised on")
      .requiredOption("--title <text>", "What is being decided")
      .requiredOption("--body <text>", "背景 / 判断标准 / 方案 — the prose a later reader sees")
      .option(
        "--option <id|label>",
        'An option, repeatable: --option "a|保持现状" --option "b|改成 X"',
        (value: string, previous: string[] = []) => [...previous, value],
        [] as string[],
      )
      .requiredOption("--recommend <optionId>", "推荐的方案 id（必填——没有推荐的提案不收）")
      .requiredOption("--recommend-reason <text>", "推荐理由（必填，写进 recommendationReason，答「为什么推它」）")
      .option("--rule-key <key>", "Idempotent rule key")
      .option("--resolver <policy>", "board | agents", "board")
      .option("--rationale <text>", "Decide immediately with this 裁决理由 (pairs with --decide)")
      .option("--decide <optionId>", "Option to choose when deciding immediately")
      .option("--constraints <text>", "附加约束 for the immediate decide")
      .option(
        "--full-body-file <path>",
        "Nine-section full rationale (durable counterpart of the card). Filed as an issue document keyed `decision-<decisionId8>` on the origin issue; id/status/proposer/time header is auto-prefixed (MUL-23)",
      )
      .option("--created-by-agent <nameOrId>", "Board path only: agent the record is attributed to (defaults to $PAPERCLIP_AGENT_ID)")
      .action(async (opts: DecisionCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const issue = await ctx.api.get<{ id: string }>(apiPath`/api/issues/${opts.originIssue}`);
          if (!issue?.id) throw new Error(`Issue not found: ${opts.originIssue}`);
          if (opts.option.length === 0) {
            throw new Error('at least one --option "<id>|<label>" is required');
          }
          assertDecisionBodyTemplate(opts.body!);
          const parsed = opts.option.map(parseDecisionOption);
          if (!parsed.some((option) => option.id === opts.recommend)) {
            throw new Error(`--recommend ${opts.recommend} is not one of the options: ${parsed.map((option) => option.id).join(", ")}`);
          }
          // Every option lands a comment back on the origin issue when chosen —
          // the verdict belongs where the reader came from.
          const options = parsed.map((option) => ({
            ...option,
            effects: [{
              type: "comment_on_issue",
              targetIssueId: issue.id,
              staleness: "lenient",
              bodyMarkdown: `决策「${opts.title}」：采纳「${option.label}」`,
            }],
          }));
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
          // The recommendation is stamped from --recommend/--recommend-reason,
          // overriding whatever the payload carried: one recommended option,
          // attributed to the proposer (the server rejects anyone else).
          const proposerId = me?.id ?? createdByAgentId;
          const stampedOptions = options.map((option) => option.id === opts.recommend
            ? { ...option, recommendedByAgentId: proposerId, recommendationReason: opts.recommendReason }
            : { ...option, recommendedByAgentId: undefined, recommendationReason: undefined });
          const created = (await ctx.api.post<DecisionRow>(apiPath`/api/companies/${ctx.companyId}/decisions`, {
            title: opts.title, body: opts.body, options: stampedOptions,
            resolverPolicy: opts.resolver, originIssueId: issue.id,
            ...(createdByAgentId ? { createdByAgentId } : {}),
            ...(opts.ruleKey ? { ruleKey: opts.ruleKey, idempotencyKey: `decision:${opts.ruleKey}` } : {}),
          }))!;
          let decided: DecisionRow | null = null;
          const chosen = opts.decide;
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
          // MUL-23: the card carries the four-part skeleton for the deciding
          // moment; the nine-section full rationale (considered-and-rejected
          // options, tradeoffs, consequences, supersession links) lives as an
          // issue document — one document per decision, keyed by decision id.
          let documentKey: string | null = null;
          if (opts.fullBodyFile) {
            const fullBody = await fsReadFile(opts.fullBodyFile, "utf8");
            documentKey = `decision-${final.id.slice(0, 8)}`;
            const decidedAt = final.status === "decided" ? (final.decidedAt ?? null) : null;
            const header = [
              `> 决策 ${final.id} · 状态 ${final.status}${decidedAt ? ` · 裁决于 ${decidedAt}` : ""}`,
              "",
            ].join("\n");
            await ctx.api.put(apiPath`/api/issues/${issue.id}/documents/${documentKey}`, {
              title: `决策完整版：${opts.title}`,
              format: "markdown",
              body: header + fullBody,
              changeSummary: "nine-section full rationale (MUL-23)",
            });
          }
          printOutput(
            ctx.json ? final : { id: final.id, status: final.status, chosen: final.chosenOptionId ?? null, documentKey },
            { json: ctx.json },
          );
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
      .option(
        "--acting-agent-id <id>",
        "Terminal that performed a board-authenticated verdict, so the card records which agent decided instead of only local-board (ignored on agent-authenticated calls, which already sign themselves)",
      )
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
          const row = (await ctx.api.post<DecisionRow>(apiPath`/api/decisions/${id}/decide`, {
            optionId: opts.option,
            inputValues,
            ...(opts.actingAgentId ? { actingAgentId: opts.actingAgentId } : {}),
          }))!;
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
