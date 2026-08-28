import { readFileSync } from "node:fs";
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
 * Team Rules CLI: the company keeps exactly one rules document (server rejects
 * a second note), so every command auto-resolves that single note — no id to
 * remember. Edits append full snapshots to the version chain; restore lands as
 * a new revision on top, never a rewind.
 */
interface RuleNote {
  id: string;
  title: string;
  body: string;
  position: number;
  updatedAt: string;
}

interface RuleNoteVersion {
  revisionNumber: number;
  title: string;
  body: string;
  label: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

export function registerTeamRulesCommands(program: Command): void {
  const teamRules = program.command("team-rules").description("Team Rules: the company's shared rule document (single note, versioned)");

  const notesPath = (companyId: string) => apiPath`/api/companies/${companyId}/team-rules/notes`;

  async function resolveNote(api: { get<T>(path: string): Promise<T | null | undefined> }, companyId: string): Promise<RuleNote> {
    const notes = (await api.get<RuleNote[]>(notesPath(companyId))) ?? [];
    if (notes.length === 0) throw new Error("no Team Rules note exists yet for this company");
    return notes[0];
  }

  addCommonClientOptions(
    teamRules
      .command("show")
      .description("Print the current Team Rules full text")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: { companyId: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const note = await resolveNote(ctx.api, ctx.companyId ?? "");
          if (opts.json) {
            printOutput(note, { json: true });
            return;
          }
          process.stdout.write(note.body.endsWith("\n") ? note.body : `${note.body}\n`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teamRules
      .command("edit")
      .description("Replace the Team Rules body (full text via --body-file or stdin); each text change appends a revision")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--body-file <path>", "Read the new full body from a file ('-' for stdin)")
      .option("--title <text>", "Also update the note title")
      .option("--label <text>", "Version label recorded on this revision")
      .action(async (opts: { companyId: string; bodyFile?: string; title?: string; label?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const note = await resolveNote(ctx.api, ctx.companyId ?? "");
          let body: string | undefined;
          if (opts.bodyFile === "-" || (!opts.bodyFile && !process.stdin.isTTY)) {
            body = readFileSync(0, "utf8");
          } else if (opts.bodyFile) {
            body = await readFile(opts.bodyFile, "utf8");
          }
          if (body === undefined && !opts.title) {
            throw new Error("nothing to edit: pass --body-file <path> (or pipe stdin) and/or --title");
          }
          if (body !== undefined && body === note.body && (!opts.title || opts.title === note.title)) {
            console.log("unchanged");
            return;
          }
          const updated = await ctx.api.patch<RuleNote>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-rules/notes/${note.id}`,
            {
              ...(body !== undefined ? { body } : {}),
              ...(opts.title ? { title: opts.title } : {}),
              ...(opts.label ? { versionLabel: opts.label } : {}),
            },
          );
          printOutput(updated, { json: ctx.json, label: ctx.json ? undefined : "Team Rules updated" });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teamRules
      .command("versions")
      .description("List the Team Rules revision history (newest first)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: { companyId: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const note = await resolveNote(ctx.api, ctx.companyId ?? "");
          const rows = (await ctx.api.get<RuleNoteVersion[]>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-rules/notes/${note.id}/versions`,
          )) ?? [];
          if (ctx.json || rows.length === 0) {
            printOutput(rows, { json: ctx.json });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              rev: row.revisionNumber,
              label: row.label ?? "",
              author: row.authorAgentId ?? row.authorUserId ?? "?",
              createdAt: row.createdAt,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teamRules
      .command("show-version")
      .description("Print one revision's full text")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--revision <n>", "Revision number")
      .action(async (opts: { companyId: string; revision: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const note = await resolveNote(ctx.api, ctx.companyId ?? "");
          const rows = (await ctx.api.get<RuleNoteVersion[]>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-rules/notes/${note.id}/versions`,
          )) ?? [];
          const row = rows.find((r) => r.revisionNumber === Number(opts.revision));
          if (!row) throw new Error(`revision ${opts.revision} not found`);
          if (opts.json) {
            printOutput(row, { json: true });
            return;
          }
          process.stdout.write(row.body.endsWith("\n") ? row.body : `${row.body}\n`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teamRules
      .command("restore")
      .description("Restore an earlier revision (lands as a new revision on top; history stays intact)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--revision <n>", "Revision number to restore")
      .action(async (opts: { companyId: string; revision: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const note = await resolveNote(ctx.api, ctx.companyId ?? "");
          const updated = await ctx.api.post<RuleNote>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-rules/notes/${note.id}/versions/${Number(opts.revision)}/restore`,
            {},
          );
          printOutput(updated, { json: ctx.json, label: ctx.json ? undefined : `restored from v${opts.revision}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
