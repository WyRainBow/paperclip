import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
} from "./common.js";

interface PersonalFile {
  id: string;
  companyId: string;
  userId: string;
  kind: string;
  path: string;
  currentHash: string | null;
  updatedAt: string;
}

export function registerPersonalFileCommands(program: Command): void {
  const personalFile = program.command("personal-file").description("Personal directive files (CLAUDE.md / AGENTS.md) under version management");

  addCommonClientOptions(
    personalFile
      .command("list")
      .description("List registered personal files")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: { companyId: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<PersonalFile[]>(apiPath`/api/companies/${ctx.companyId}/personal-files`)) ?? [];
          if (ctx.json || rows.length === 0) {
            printOutput(rows, { json: ctx.json });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ id: row.id, kind: row.kind, path: row.path, hash: row.currentHash?.slice(0, 8) ?? "none" }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    personalFile
      .command("register")
      .description("Register a personal directive file for version management (filesystem stays the source of truth)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--kind <kind>", "claude-md | agents-md | workspace-agents")
      .requiredOption("--path <path>", "Absolute path of the file")
      .action(async (opts: { companyId: string; kind: string; path: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<PersonalFile>(apiPath`/api/companies/${ctx.companyId}/personal-files`, {
            kind: opts.kind,
            path: opts.path,
          });
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    personalFile
      .command("sync")
      .description("Check in the file's current content; no-op when unchanged")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<fileId>", "Registered file id")
      .option("--label <text>", "Optional note for this revision")
      .action(async (fileId: string, opts: { companyId: string; label?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const files = (await ctx.api.get<PersonalFile[]>(apiPath`/api/companies/${ctx.companyId}/personal-files`)) ?? [];
          const file = files.find((row) => row.id === fileId);
          if (!file) throw new Error(`personal file not found: ${fileId} (see personal-file list)`);
          const content = await readFile(file.path, "utf8");
          const result = (await ctx.api.post<{ unchanged: boolean; revisionNumber: number }>(
            apiPath`/api/companies/${ctx.companyId}/personal-files/${file.id}/sync`,
            { content, label: opts.label },
          )) ?? { unchanged: true, revisionNumber: 0 };
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(result.unchanged ? `unchanged (rev ${result.revisionNumber})` : `checked in rev ${result.revisionNumber}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    personalFile
      .command("versions")
      .description("List versions of a registered personal file")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<fileId>", "Registered file id")
      .action(async (fileId: string, opts: { companyId: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Array<{ revisionNumber: number; label: string | null; createdAt: string }>>(
            apiPath`/api/companies/${ctx.companyId}/personal-files/${fileId}/versions`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    personalFile
      .command("show")
      .description("Print one version's content (view or export; writing back is manual)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<fileId>", "Registered file id")
      .requiredOption("--revision <n>", "Revision number")
      .action(async (fileId: string, opts: { companyId: string; revision: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = (await ctx.api.get<{ revisionNumber: number; content: string }>(
            apiPath`/api/companies/${ctx.companyId}/personal-files/${fileId}/versions/${opts.revision}`,
          )) ?? null;
          if (!row) throw new Error("version not found");
          if (ctx.json) {
            printOutput(row, { json: true });
            return;
          }
          process.stdout.write(row.content);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
