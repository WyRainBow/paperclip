import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
} from "./common.js";

interface RecallResult {
  query: string;
  budgetChars: number;
  usedChars: number;
  resultCount: number;
  totalHits: number;
  results: Array<{
    source: string;
    space: string | null;
    path: string | null;
    title: string;
    snippet: string;
    degraded: boolean;
    assetKind: string;
    assetId: string;
    adoptionBoost: number;
  }>;
  references: string;
}

interface AssetHealthRow {
  assetKind: string;
  assetId: string;
  title: string;
  path: string | null;
  servedCount: number;
  citedCount: number;
  lastServedAt: string | null;
  lastCitedAt: string | null;
  deadWeight: boolean;
}

export function registerWorkspaceRecallCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === "workspace");
  if (!existing) return;

  addCommonClientOptions(
    existing
      .command("recall")
      .description("Search Team Wiki + Team Rules within a token budget; returns snippets with reference declarations")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .requiredOption("--query <query>", "What to search for")
      .option("--budget <chars>", "Character budget for results (default 2000, max 6000)")
      .option("--issue <id>", "Issue this recall serves — recorded on the ledger so adoption can be checked against the card later")
      .option("--session <id>", "Session id to record on the ledger when there is no issue")
      .action(async (opts: { companyId?: string; query: string; budget?: string; issue?: string; session?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams({ q: opts.query });
          if (opts.budget) params.set("budget", opts.budget);
          if (opts.issue) params.set("issue", opts.issue);
          if (opts.session) params.set("session", opts.session);
          const base = apiPath`/api/companies/${ctx.companyId}/workspace/recall`;
          const resp = await ctx.api.get<RecallResult>(`${base}?${params}`);
          if (!resp) throw new Error("recall returned no data");
          if (opts.json) {
            printOutput(resp, { json: true });
            return;
          }
          console.error(`查询「${resp.query}」：${resp.resultCount}/${resp.totalHits} 条命中（预算 ${resp.usedChars}/${resp.budgetChars} 字符）\n`);
          for (const hit of resp.results) {
            const loc = hit.space ? `[${hit.source}/${hit.space}]` : `[${hit.source}]`;
            const adopted = hit.adoptionBoost > 0 ? ` ·已被采纳过(+${hit.adoptionBoost})` : "";
            if (hit.degraded) {
              console.log(`${loc} ${hit.title}${adopted} — 预算不足，仅标题`);
            } else {
              console.log(`${loc} ${hit.title} (${hit.path})${adopted}`);
              console.log(`  ${hit.snippet.replace(/\n/g, "\n  ")}`);
            }
            console.log();
          }
          console.log(`引用声明：\n${resp.references}`);
          console.log(`\n用上哪几条，收尾时声明一次：paperclipai workspace cite --asset <上面的 kind:id> [--issue <卡 id>]`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("cite")
      .description("Declare which recalled assets this session actually used — the adoption half of the ledger")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .requiredOption("--asset <kind:id...>", "Asset refs copied from a recall response, e.g. rule:<uuid> wiki:<uuid>")
      .option("--issue <id>", "Issue this work belongs to — the key that lets a human check the claim against the card")
      .option("--session <id>", "Session id, when there is no issue to attach to")
      .action(async (opts: { companyId?: string; asset: string[]; issue?: string; session?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const resp = await ctx.api.post<{ declared: number; recorded: number; duplicates: number }>(
            apiPath`/api/companies/${ctx.companyId}/workspace/citations`,
            { issueId: opts.issue, sessionId: opts.session, assets: opts.asset },
          );
          if (opts.json) {
            printOutput(resp, { json: true });
            return;
          }
          console.log(`声明 ${resp?.declared ?? 0} 条，新记 ${resp?.recorded ?? 0} 条，重复 ${resp?.duplicates ?? 0} 条`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("assets-health")
      .description("Served/cited counts per team asset — names dead-weight candidates, prunes nothing")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .option("--dead-only", "Only show assets served enough to have had their chance and never cited")
      .action(async (opts: { companyId?: string; deadOnly?: boolean; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const resp = await ctx.api.get<{ assets: AssetHealthRow[]; deadWeightCount: number }>(
            apiPath`/api/companies/${ctx.companyId}/workspace/assets/health`,
          );
          const assets = (resp?.assets ?? []).filter((row) => (opts.deadOnly ? row.deadWeight : true));
          if (opts.json) {
            printOutput({ ...resp, assets }, { json: true });
            return;
          }
          console.error(`资产 ${assets.length} 条，死重候选 ${resp?.deadWeightCount ?? 0} 条\n`);
          for (const row of assets) {
            const flag = row.deadWeight ? " ⚠死重" : "";
            console.log(`[${row.assetKind}] ${row.title}${row.path ? ` (${row.path})` : ""}${flag}`);
            console.log(`  发出 ${row.servedCount} 次 / 采纳 ${row.citedCount} 次 · ${row.assetKind}:${row.assetId}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("rules")
      .description("Read Team Rules full text — no search, no budget, the complete rules")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .action(async (opts: { companyId?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Array<{
            id: string; title: string; body: string; updatedAt: string;
          }>>(
            apiPath`/api/companies/${ctx.companyId}/workspace/rules`,
          )) ?? [];
          if (opts.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const note of rows) {
            console.log(`=== ${note.title} ===\n`);
            console.log(note.body);
            console.log(`\n--- 更新于 ${note.updatedAt} ---\n`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
