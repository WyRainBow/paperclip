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
 * Team Wiki CLI (MUL-110). The HTTP surface already accepted agent keys —
 * only the terminal had no way in, so wiki pages could be read via
 * `workspace recall` but written nowhere except the web UI.
 *
 * Pages are addressed by their path (`guides/glossary`), not their UUID: the
 * path is what a person and an agent both already know, and it is unique per
 * space. A raw UUID still works for the rare case where two paths collide
 * mid-rename.
 */
const SPACES = ["paperclip", "agent", "personal"] as const;

interface WikiPage {
  id: string;
  space: string;
  path: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface WikiPageVersion {
  revisionNumber: number;
  path: string;
  title: string;
  body: string;
  label: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSpace(raw: string): string {
  const space = SPACES.find((candidate) => candidate === raw);
  if (!space) throw new Error(`--space must be one of ${SPACES.join(", ")}`);
  return space;
}

/** Same normalization the server applies, so `--path /a/b/` and `a/b` address one page. */
function normalizePath(raw: string): string {
  const segments = raw.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error("path is required");
  return segments.join("/");
}

export function registerTeamWikiCommands(program: Command): void {
  const wiki = program
    .command("team-wiki")
    .description("Team Wiki pages (spaces: paperclip / agent / personal), versioned like Team Rules");

  const pagesPath = (companyId: string, space: string) =>
    apiPath`/api/companies/${companyId}/team-wiki/${space}/pages`;

  async function listPages(
    api: { get<T>(path: string): Promise<T | null> },
    companyId: string,
    space: string,
  ): Promise<WikiPage[]> {
    return (await api.get<WikiPage[]>(pagesPath(companyId, space))) ?? [];
  }

  /** Resolve `guides/glossary` (or a UUID) to the page it names, within one space. */
  async function resolvePage(
    api: { get<T>(path: string): Promise<T | null> },
    companyId: string,
    space: string,
    ref: string,
  ): Promise<WikiPage> {
    const pages = await listPages(api, companyId, space);
    if (UUID_RE.test(ref)) {
      const byId = pages.find((page) => page.id === ref);
      if (byId) return byId;
      throw new Error(`no page with id ${ref} in space ${space}`);
    }
    const wanted = normalizePath(ref);
    const byPath = pages.find((page) => page.path === wanted);
    if (byPath) return byPath;
    throw new Error(`no page at ${space}/${wanted} — run \`team-wiki list --space ${space}\` to see what exists`);
  }

  /** Body from --body-file, or piped stdin when the command is not attached to a TTY. */
  async function readBody(bodyFile: string | undefined): Promise<string | undefined> {
    if (bodyFile === "-" || (!bodyFile && !process.stdin.isTTY)) return readFileSync(0, "utf8");
    if (bodyFile) return readFile(bodyFile, "utf8");
    return undefined;
  }

  addCommonClientOptions(
    wiki
      .command("list")
      .description("List pages in a space (path + title), optionally filtered")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .option("-q, --query <text>", "Substring filter on title, body and path")
      .action(async (opts: { companyId: string; space: string; query?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const suffix = opts.query ? `?q=${encodeURIComponent(opts.query)}` : "";
          const rows = (await ctx.api.get<WikiPage[]>(
            `${pagesPath(ctx.companyId ?? "", space)}${suffix}`,
          )) ?? [];
          if (ctx.json || rows.length === 0) {
            printOutput(rows, { json: ctx.json });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ path: row.path, title: row.title, id: row.id, updatedAt: row.updatedAt }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    wiki
      .command("show")
      .description("Print one page's full body")
      .argument("<pathOrId>", "Page path (e.g. guides/glossary) or UUID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .action(async (ref: string, opts: { companyId: string; space: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const page = await resolvePage(ctx.api, ctx.companyId ?? "", space, ref);
          if (ctx.json) {
            printOutput(page, { json: true });
            return;
          }
          process.stdout.write(page.body.endsWith("\n") ? page.body : `${page.body}\n`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    wiki
      .command("create")
      .description("Create a page (body via --body-file or stdin)")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .requiredOption("--title <text>", "Page title")
      .option("--path <path>", "Page path (defaults to the title)")
      .option("--body-file <path>", "Read the body from a file ('-' for stdin)")
      .action(async (opts: {
        companyId: string; space: string; title: string; path?: string; bodyFile?: string; json?: boolean;
      }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const body = (await readBody(opts.bodyFile)) ?? "";
          const created = await ctx.api.post<WikiPage>(pagesPath(ctx.companyId ?? "", space), {
            title: opts.title,
            ...(opts.path ? { path: normalizePath(opts.path) } : {}),
            body,
          });
          printOutput(created, { json: ctx.json, label: ctx.json ? undefined : `created ${space}/${created?.path}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    wiki
      .command("edit")
      .description("Replace a page's body and/or title; each text change appends a revision")
      .argument("<pathOrId>", "Page path (e.g. guides/glossary) or UUID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .option("--body-file <path>", "Read the new full body from a file ('-' for stdin)")
      .option("--title <text>", "Also update the title")
      .option("--new-path <path>", "Move the page to a new path")
      .option("--label <text>", "Version label recorded on this revision")
      .action(async (ref: string, opts: {
        companyId: string; space: string; bodyFile?: string; title?: string;
        newPath?: string; label?: string; json?: boolean;
      }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const page = await resolvePage(ctx.api, ctx.companyId ?? "", space, ref);
          const body = await readBody(opts.bodyFile);
          if (body === undefined && !opts.title && !opts.newPath) {
            throw new Error("nothing to edit: pass --body-file <path> (or pipe stdin), --title, and/or --new-path");
          }
          const updated = await ctx.api.patch<WikiPage>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/${space}/pages/${page.id}`,
            {
              ...(body !== undefined ? { body } : {}),
              ...(opts.title ? { title: opts.title } : {}),
              ...(opts.newPath ? { path: normalizePath(opts.newPath) } : {}),
              ...(opts.label ? { versionLabel: opts.label } : {}),
            },
          );
          printOutput(updated, { json: ctx.json, label: ctx.json ? undefined : `updated ${space}/${updated?.path}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    wiki
      .command("versions")
      .description("List a page's revision history (newest first)")
      .argument("<pathOrId>", "Page path (e.g. guides/glossary) or UUID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .action(async (ref: string, opts: { companyId: string; space: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const page = await resolvePage(ctx.api, ctx.companyId ?? "", space, ref);
          const rows = (await ctx.api.get<WikiPageVersion[]>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/${space}/pages/${page.id}/versions`,
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
    wiki
      .command("restore")
      .description("Restore an earlier revision (lands as a new revision on top; history stays intact)")
      .argument("<pathOrId>", "Page path (e.g. guides/glossary) or UUID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .requiredOption("--revision <n>", "Revision number to restore")
      .action(async (ref: string, opts: { companyId: string; space: string; revision: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const page = await resolvePage(ctx.api, ctx.companyId ?? "", space, ref);
          const revision = Number(opts.revision);
          if (!Number.isInteger(revision)) throw new Error("--revision must be an integer");
          const updated = await ctx.api.post<WikiPage>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/${space}/pages/${page.id}/versions/${revision}/restore`,
            {},
          );
          printOutput(updated, { json: ctx.json, label: ctx.json ? undefined : `restored from v${revision}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    wiki
      .command("delete")
      .description("Delete a page permanently (history goes with it)")
      .argument("<pathOrId>", "Page path (e.g. guides/glossary) or UUID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--space <space>", `One of ${SPACES.join(" | ")}`)
      .action(async (ref: string, opts: { companyId: string; space: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const space = requireSpace(opts.space);
          const page = await resolvePage(ctx.api, ctx.companyId ?? "", space, ref);
          const deleted = await ctx.api.delete<WikiPage>(
            apiPath`/api/companies/${ctx.companyId ?? ""}/team-wiki/${space}/pages/${page.id}`,
          );
          printOutput(deleted, { json: ctx.json, label: ctx.json ? undefined : `deleted ${space}/${page.path}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
