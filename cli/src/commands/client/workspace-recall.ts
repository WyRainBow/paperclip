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
  }>;
  references: string;
}

export function registerWorkspaceRecallCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === "workspace");
  if (!existing) return;

  addCommonClientOptions(
    existing
      .command("recall")
      .description("Search Team Wiki + Team Rules within a token budget; returns snippets with reference declarations")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--query <query>", "What to search for")
      .option("--budget <chars>", "Character budget for results (default 2000, max 6000)")
      .action(async (opts: { companyId: string; query: string; budget?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams({ q: opts.query });
          if (opts.budget) params.set("budget", opts.budget);
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
            if (hit.degraded) {
              console.log(`${loc} ${hit.title} — 预算不足，仅标题`);
            } else {
              console.log(`${loc} ${hit.title} (${hit.path})`);
              console.log(`  ${hit.snippet.replace(/\n/g, "\n  ")}`);
            }
            console.log();
          }
          console.log(`引用声明：\n${resp.references}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("rules")
      .description("Read Team Rules full text — no search, no budget, the complete rules")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: { companyId: string; json?: boolean }) => {
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
