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

/**
 * Personal directive files (global CLAUDE.md / AGENTS.md) ride the team-wiki
 * engine: third space "personal", markdown + revision chain + diff reused
 * (user 2026-08-26). The filesystem stays the source of truth — register and
 * sync are check-ins; rollback is export-only.
 */
interface WikiPage {
  id: string;
  space: string;
  path: string;
  title: string;
  body: string;
  latestRevisionNumber?: number;
  updatedAt: string;
}

export function registerPersonalFileCommands(program: Command): void {
  const personalFile = program.command("personal-file").description("Personal directive files (CLAUDE.md / AGENTS.md) as wiki pages in the personal space");

  const pagesPath = (companyId: string) => apiPath`/api/companies/${companyId}/team-wiki/personal/pages`;
const WIKI = (companyId: string | undefined) => apiPath`/api/companies/${companyId}/team-wiki/personal/pages`;

  addCommonClientOptions(
    personalFile
      .command("list")
      .description("List registered personal files")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: { companyId: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<WikiPage[]>(pagesPath(ctx.companyId ?? ""))) ?? [];
          if (ctx.json || rows.length === 0) {
            printOutput(rows, { json: ctx.json });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ id: row.id, path: row.path, title: row.title, rev: row.latestRevisionNumber ?? 1 }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    personalFile
      .command("register")
      .description("Register a personal directive file as a personal-space wiki page")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--kind <kind>", "claude-md | agents-md | workspace-agents (becomes the page path)")
      .requiredOption("--path <path>", "Absolute filesystem path of the file")
      .action(async (opts: { companyId: string; kind: string; path: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<WikiPage>(pagesPath(ctx.companyId ?? ""), {
            path: opts.kind,
            title: opts.path,
            body: "",
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
      .argument("<pageId>", "Wiki page id (see list)")
      .option("--label <text>", "Optional note for this revision")
      .action(async (pageId: string, opts: { companyId: string; label?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const pages = (await ctx.api.get<WikiPage[]>(pagesPath(ctx.companyId ?? ""))) ?? [];
          const page = pages.find((candidate) => candidate.id === pageId) ?? null;
          if (!page) throw new Error(`personal file page not found: ${pageId} (see personal-file list)`);
          const content = await readFile(page.title, "utf8");
          if (content === page.body) {
            console.log(`unchanged (rev ${page.latestRevisionNumber ?? 1})`);
            return;
          }
          const updated = (await ctx.api.patch<WikiPage>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/personal/pages/${pageId}`,
            { body: content, ...(opts.label ? { changeSummary: opts.label } : {}) },
          )) ?? null;
          if (opts.json) {
            printOutput(updated, { json: true });
            return;
          }
          console.log(updated ? `checked in rev ${updated.latestRevisionNumber ?? "?"}` : "checked in");
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
      .argument("<pageId>", "Wiki page id")
      .action(async (pageId: string, opts: { companyId: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Array<{ revisionNumber: number; label: string | null; createdAt: string }>>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/personal/pages/${pageId}/versions`,
          )) ?? [];
          printOutput(rows, { json: opts.json });
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
      .argument("<pageId>", "Wiki page id")
      .requiredOption("--revision <n>", "Revision number")
      .action(async (pageId: string, opts: { companyId: string; revision: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Array<{ revisionNumber: number; content?: string; body?: string }>>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/personal/pages/${pageId}/versions`,
          )) ?? [];
          const row = rows.find((r) => r.revisionNumber === Number(opts.revision)) ?? null;
          if (!row) throw new Error(`revision ${opts.revision} not found`);
          const content = row.content ?? row.body ?? "";
          if (opts.json) {
            printOutput({ revisionNumber: row.revisionNumber, content }, { json: true });
            return;
          }
          process.stdout.write(content);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
