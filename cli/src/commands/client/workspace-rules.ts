import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
} from "./common.js";

export function registerWorkspaceRulesCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === "workspace");
  if (!existing) return;

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
