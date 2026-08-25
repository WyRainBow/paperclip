import { Command } from "commander";
import {
  agentSkillAssignmentModeSchema,
  type AgentSkillAssignmentMode,
  type Agent,
  type AgentSkillSnapshot,
  type CatalogSkill,
  type CompanySkill,
  type CompanySkillAuditResult,
  type CompanySkillDetail,
  type CompanySkillFileDetail,
  type CompanySkillFileInventoryEntry,
  type CompanySkillVersionFileInventoryEntry,
  type CompanySkillImportResult,
  type CompanySkillInstallCatalogResult,
  type CompanySkillListItem,
  type CompanySkillProjectScanResult,
  type CompanySkillUpdateStatus,
} from "@paperclipai/shared";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface SkillsOptions extends BaseClientOptions {
  companyId?: string;
}

interface SkillFileOptions extends SkillsOptions {
  path?: string;
}

interface SkillCreateOptions extends SkillsOptions {
  name: string;
  slug?: string;
  description?: string;
  bodyFile?: string;
}

interface SkillMaterializeOptions extends SkillsOptions {
  target: string[];
  skill: string[];
  dryRun: boolean;
  force: boolean;
}

interface SkillScanProjectsOptions extends SkillsOptions {
  projectId?: string[];
  workspaceId?: string[];
}

interface CatalogBrowseOptions extends BaseClientOptions {
  kind?: string;
  category?: string;
  query?: string;
}

interface CatalogInstallOptions extends SkillsOptions {
  as?: string;
  force?: boolean;
}

interface SkillUpdateOptions extends SkillsOptions {
  all?: boolean;
  force?: boolean;
}

interface ConfirmedSkillOptions extends SkillsOptions {
  yes?: boolean;
  force?: boolean;
}

interface AgentSkillSyncOptions extends SkillsOptions {
  skill?: string[];
  mode: AgentSkillAssignmentMode;
}

type CompanySkillReferenceTarget = Pick<CompanySkillListItem, "id" | "key" | "slug" | "name">;

export interface CompanySkillCheckRow {
  skill: CompanySkillReferenceTarget;
  status: CompanySkillUpdateStatus;
}

export interface CompanySkillUpdateRow {
  skillRef: string;
  action: "updated" | "skipped" | "failed";
  skill?: CompanySkill;
  status?: CompanySkillUpdateStatus;
  reason?: string;
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("Company and agent skill operations");

  addCommonClientOptions(
    skills
      .command("browse")
      .description("Browse app-shipped catalog skills without installing them")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .option("--query <text>", "Search catalog text")
      .action(async (opts: CatalogBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogSkills(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogSkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("search")
      .description("Search app-shipped catalog skills without installing them")
      .argument("<query>", "Search text")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .action(async (query: string, opts: CatalogBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogSkills(ctx, { ...opts, query });
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogSkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("inspect")
      .description("Inspect an app-shipped catalog skill before installing it")
      .argument("<catalogRef>", "Catalog skill ID, key, or unique slug")
      .action(async (catalogRef: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const detail = await getCatalogSkill(ctx, catalogRef);
          if (ctx.json) {
            printOutput(detail, { json: true });
            return;
          }
          printCatalogSkillDetail(detail);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("install")
      .description("Install a catalog skill into the company skill library; does not attach it to agents")
      .argument("<catalogRef>", "Catalog skill ID, key, or unique slug")
      .option("--as <slug>", "Company skill slug override")
      .option("--force", "Replace a same-key catalog-managed skill when the server allows it", false)
      .action(async (catalogRef: string, opts: CatalogInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillInstallCatalogResult>(
            `/api/companies/${ctx.companyId}/skills/install-catalog`,
            {
              catalogSkillId: catalogRef,
              slug: opts.as,
              force: opts.force || undefined,
            },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogInstallResult(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("list")
      .description("List company skills")
      .action(async (opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listCompanySkills(ctx);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCompanySkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("show")
      .description("Show company skill details")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const detail = await ctx.api.get<CompanySkillDetail>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          printOutput(detail, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("file")
      .description("Print a company skill file")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .option("--path <path>", "Relative file path", "SKILL.md")
      .action(async (skillRef: string, opts: SkillFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const params = new URLSearchParams({ path: opts.path?.trim() || "SKILL.md" });
          const file = await ctx.api.get<CompanySkillFileDetail>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/files?${params.toString()}`,
          );
          if (ctx.json) {
            printOutput(file, { json: true });
            return;
          }
          process.stdout.write(file?.content ?? "");
          if (file?.content && !file.content.endsWith("\n")) {
            process.stdout.write("\n");
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("import")
      .description("Import company skills from a local path, GitHub, skills.sh, or URL source")
      .argument("<source>", "Skill source")
      .action(async (source: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillImportResult>(
            `/api/companies/${ctx.companyId}/skills/import`,
            { source },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(
            `Imported ${result?.imported.length ?? 0} skill(s); warnings=${result?.warnings.length ?? 0}`,
          );
          printCompanySkillRows(result?.imported ?? []);
          for (const warning of result?.warnings ?? []) {
            console.log(`warning=${warning}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("create")
      .description("Create a managed local company skill")
      .requiredOption("--name <name>", "Skill name")
      .option("--slug <slug>", "Skill slug")
      .option("--description <text>", "Skill description")
      .option("--body-file <path>", "Markdown body file; use - to read stdin")
      .action(async (opts: SkillCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const markdown = opts.bodyFile ? await readBodyFile(opts.bodyFile) : undefined;
          const created = await ctx.api.post<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills`,
            {
              name: opts.name,
              slug: opts.slug,
              description: opts.description,
              markdown,
            },
          );
          if (ctx.json) {
            printOutput(created, { json: true });
            return;
          }
          console.log(`Created skill ${created?.name ?? opts.name} (${created?.key ?? created?.id ?? "unknown"})`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("scan-projects")
      .description("Scan project workspaces for skills")
      .option("--project-id <id>", "Project ID to scan; may be repeated", collectOptionValue, [] as string[])
      .option("--workspace-id <id>", "Workspace ID to scan; may be repeated", collectOptionValue, [] as string[])
      .action(async (opts: SkillScanProjectsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillProjectScanResult>(
            `/api/companies/${ctx.companyId}/skills/scan-projects`,
            {
              projectIds: emptyToUndefined(opts.projectId),
              workspaceIds: emptyToUndefined(opts.workspaceId),
            },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(
            `Scanned projects=${result?.scannedProjects ?? 0} workspaces=${result?.scannedWorkspaces ?? 0} discovered=${result?.discovered ?? 0} imported=${result?.imported.length ?? 0} updated=${result?.updated.length ?? 0} skipped=${result?.skipped.length ?? 0} conflicts=${result?.conflicts.length ?? 0} warnings=${result?.warnings.length ?? 0}`,
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("materialize")
      .description(
        "Materialize company skills into local terminal skill directories (e.g. ~/.codex/skills) with fingerprint protection",
      )
      .option("-t, --target <path>", "Target skill directory; may be repeated", collectOptionValue, [] as string[])
      .option("-s, --skill <ref>", "Limit to specific company skills; may be repeated", collectOptionValue, [] as string[])
      .option("--dry-run", "Report planned writes without writing anything", false)
      .option("--force", "Overwrite locally-modified or foreign skill directories", false)
      .action(async (opts: SkillMaterializeOptions) => {
        try {
          if (opts.target.length === 0) {
            throw new Error("At least one --target directory is required (e.g. --target ~/.codex/skills).");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await materializeCompanySkills(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printSkillMaterializeRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("check")
      .description("Check company skill update status")
      .argument("[skillRef]", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await checkCompanySkills(ctx, skillRef);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCompanySkillCheckRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("update")
      .description("Install company skill updates")
      .argument("[skillRef]", "Company skill ID, key, or unique slug")
      .option("--all", "Check all skills and install available updates", false)
      .option("--force", "Discard local-modification or soft-audit holds; hard-stop audit findings still fail", false)
      .action(async (skillRef: string | undefined, opts: SkillUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.all && skillRef?.trim()) {
            throw new Error("Use either a skill reference or --all, not both.");
          }
          const rows = opts.all
            ? await updateAllCompanySkills(ctx, opts)
            : [await updateOneCompanySkill(ctx, requireSkillRef(skillRef), opts)];
          if (ctx.json) {
            printOutput(rows.length === 1 && !opts.all ? rows[0] : rows, { json: true });
            return;
          }
          printCompanySkillUpdateRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("audit")
      .description("Audit installed company skill bytes without executing them")
      .argument("[skillRef]", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await auditCompanySkills(ctx, skillRef);
          if (ctx.json) {
            printOutput(rows.length === 1 && skillRef ? rows[0]?.audit : rows, { json: true });
            return;
          }
          printCompanySkillAuditRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("reset")
      .description("Reset a catalog-managed company skill to its pinned installed origin")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .option("--yes", "Confirm reset without prompting", false)
      .option("--force", "Discard local modifications or accept soft audit warnings; hard-stop audit findings still fail", false)
      .action(async (skillRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          await confirmDangerousAction(opts.yes, `Reset catalog skill "${skill.name}" (${skill.key}) to its pinned origin?`);
          const reset = await ctx.api.post<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/reset`,
            { force: opts.force || undefined },
          );
          if (ctx.json) {
            printOutput(reset, { json: true });
            return;
          }
          console.log(`Reset skill ${reset?.name ?? skill.name} (${reset?.key ?? skill.key}) to pinned origin.`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("remove")
      .description("Remove a company skill")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .option("--yes", "Confirm removal without prompting", false)
      .action(async (skillRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          await confirmDangerousAction(opts.yes, `Remove company skill "${skill.name}" (${skill.key})?`);
          const removed = await ctx.api.delete<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          if (ctx.json) {
            printOutput(removed, { json: true });
            return;
          }
          console.log(`Removed skill ${removed?.name ?? skill.name} (${removed?.key ?? skill.key})`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  registerAgentSkillCommands(skills);
}

function registerAgentSkillCommands(skills: Command): void {
  const agent = skills.command("agent").description("Agent desired-skill and runtime sync operations");

  addCommonClientOptions(
    agent
      .command("list")
      .description("List an agent runtime skill snapshot")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .action(async (agentRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          const snapshot = await ctx.api.get<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills`,
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    agent
      .command("sync")
      .description("Merge an agent's desired company skills and sync runtime state")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("--skill <skillRef>", "Desired company skill ID, key, or slug; may be repeated", collectOptionValue, [] as string[])
      .requiredOption(
        "--mode <mode>",
        "Merge mode: add keeps other skills; remove deletes only named skills; replace destructively overwrites the complete set",
      )
      .action(async (agentRef: string, opts: AgentSkillSyncOptions) => {
        try {
          const desiredSkills = opts.skill ?? [];
          if (desiredSkills.length === 0) {
            throw new Error("At least one --skill value is required for skills agent sync.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          const mode = agentSkillAssignmentModeSchema.parse(opts.mode);
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills/sync`,
            { desiredSkills, mode },
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          console.log(
            `Desired company skills updated with ${mode} mode for ${agentRow.name} (${agentRow.id}); runtime sync returned ${snapshot?.entries.length ?? 0} entrie(s).`,
          );
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    agent
      .command("clear")
      .description("Clear an agent's desired company skills and sync runtime state")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("--yes", "Confirm clear without prompting", false)
      .action(async (agentRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          await confirmDangerousAction(
            opts.yes,
            `Clear desired company skills for "${agentRow.name}" (${agentRow.id})?`,
          );
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills/sync`,
            { desiredSkills: [], mode: "replace" },
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          console.log(
            `Desired company skills cleared for ${agentRow.name} (${agentRow.id}).`,
          );
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function listCompanySkills(ctx: ResolvedClientContext): Promise<CompanySkillListItem[]> {
  return (await ctx.api.get<CompanySkillListItem[]>(`/api/companies/${ctx.companyId}/skills`)) ?? [];
}

export interface SkillMaterializeRow {
  skill: CompanySkillReferenceTarget;
  target: string;
  status: "created" | "updated" | "up-to-date" | "skipped-foreign" | "skipped-local-modified" | "skipped-no-files" | "dry-run";
  files: number;
  note?: string;
}

const SKILL_SIDECAR = ".paperclip-skill.json";

interface SkillSidecar {
  skillId: string;
  key: string;
  remoteHash: string;
  localHash: string;
  syncedAt: string;
}

function hashFileMap(files: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files.get(path) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parentDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolvePath(value);
}

interface SkillVersionSummary {
  id: string;
  revisionNumber: number | null;
  fileInventory?: CompanySkillVersionFileInventoryEntry[];
}

async function fetchSkillFiles(
  ctx: ResolvedClientContext,
  skillId: string,
): Promise<Map<string, string>> {
  // The latest version's fileInventory carries each file's content; fall back
  // to per-file reads only for entries that somehow ship without one.
  const versions = await ctx.api.get<SkillVersionSummary[]>(
    `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/versions`,
  );
  const latest = [...(versions ?? [])].sort(
    (a, b) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0),
  )[0];
  const files = new Map<string, string>();
  for (const entry of latest?.fileInventory ?? []) {
    if (typeof entry.content === "string") {
      files.set(entry.path, entry.content);
      continue;
    }
    const detail = await ctx.api.get<CompanySkillFileDetail>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(entry.path)}`,
    );
    if (detail?.content !== undefined) files.set(detail.path, detail.content);
  }
  return files;
}

async function readSidecar(skillDir: string): Promise<SkillSidecar | null> {
  try {
    const raw = await readFile(join(skillDir, SKILL_SIDECAR), "utf8");
    const parsed = JSON.parse(raw) as SkillSidecar;
    if (parsed && typeof parsed.skillId === "string" && typeof parsed.remoteHash === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

async function localFileMap(skillDir: string, paths: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of paths) {
    try {
      files.set(path, await readFile(join(skillDir, path), "utf8"));
    } catch {
      // Missing file counts as absent rather than erroring the whole sync.
    }
  }
  return files;
}

export async function materializeCompanySkills(
  ctx: ResolvedClientContext,
  opts: SkillMaterializeOptions,
): Promise<SkillMaterializeRow[]> {
  const all = await listCompanySkills(ctx);
  const selected = opts.skill.length > 0
    ? opts.skill.map((ref) => resolveCompanySkillReference(all, ref))
    : all;

  const rows: SkillMaterializeRow[] = [];
  for (const skill of selected) {
    const remoteFiles = await fetchSkillFiles(ctx, skill.id);
    const remoteHash = hashFileMap(remoteFiles);
    if (remoteFiles.size === 0) {
      for (const rawTarget of opts.target) {
        rows.push({
          skill,
          target: expandHome(rawTarget),
          status: "skipped-no-files",
          files: 0,
          note: "skill has no retrievable files (plugin-managed or empty); nothing to materialize",
        });
      }
      continue;
    }
    for (const rawTarget of opts.target) {
      const target = expandHome(rawTarget);
      const skillDir = join(target, skill.slug);
      const sidecar = await readSidecar(skillDir);
      let dirExists = true;
      try {
        await readdir(skillDir);
      } catch {
        dirExists = false;
      }

      if (!dirExists) {
        if (opts.dryRun) {
          rows.push({ skill, target, status: "dry-run", files: remoteFiles.size, note: "would create" });
          continue;
        }
        await mkdir(skillDir, { recursive: true });
        for (const [path, content] of remoteFiles) {
          await mkdir(join(skillDir, parentDirOf(path)), { recursive: true });
          await writeFile(join(skillDir, path), content, "utf8");
        }
        const nextSidecar: SkillSidecar = {
          skillId: skill.id, key: skill.key, remoteHash, localHash: remoteHash, syncedAt: new Date().toISOString(),
        };
        await writeFile(join(skillDir, SKILL_SIDECAR), JSON.stringify(nextSidecar, null, 2) + "\n", "utf8");
        rows.push({ skill, target, status: "created", files: remoteFiles.size });
        continue;
      }

      if (!sidecar) {
        if (!opts.force) {
          rows.push({ skill, target, status: "skipped-foreign", files: 0, note: "directory exists without a paperclip sidecar; use --force" });
          continue;
        }
      } else {
        if (sidecar.remoteHash === remoteHash) {
          rows.push({ skill, target, status: "up-to-date", files: remoteFiles.size });
          continue;
        }
        const currentLocal = await localFileMap(skillDir, [...remoteFiles.keys()]);
        if (hashFileMap(currentLocal) !== sidecar.localHash && !opts.force) {
          rows.push({ skill, target, status: "skipped-local-modified", files: 0, note: "local edits since last sync; use --force to overwrite" });
          continue;
        }
      }

      if (opts.dryRun) {
        rows.push({ skill, target, status: "dry-run", files: remoteFiles.size, note: sidecar ? "would update" : "would force-create" });
        continue;
      }
      for (const [path, content] of remoteFiles) {
        await mkdir(join(skillDir, parentDirOf(path)), { recursive: true });
        await writeFile(join(skillDir, path), content, "utf8");
      }
      const nextSidecar: SkillSidecar = {
        skillId: skill.id, key: skill.key, remoteHash, localHash: remoteHash, syncedAt: new Date().toISOString(),
      };
      await writeFile(join(skillDir, SKILL_SIDECAR), JSON.stringify(nextSidecar, null, 2) + "\n", "utf8");
      rows.push({ skill, target, status: "updated", files: remoteFiles.size });
    }
  }
  return rows;
}

function printSkillMaterializeRows(rows: SkillMaterializeRow[]): void {
  for (const row of rows) {
    console.log(`${row.status.padEnd(24)} ${row.skill.key} -> ${row.target} (${row.files} files)${row.note ? ` — ${row.note}` : ""}`);
  }
}

async function listCatalogSkills(
  ctx: ResolvedClientContext,
  opts: CatalogBrowseOptions,
): Promise<CatalogSkill[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, "kind", opts.kind);
  appendQueryParam(params, "category", opts.category);
  appendQueryParam(params, "q", opts.query);
  const query = params.toString();
  return (await ctx.api.get<CatalogSkill[]>(`/api/skills/catalog${query ? `?${query}` : ""}`)) ?? [];
}

async function getCatalogSkill(ctx: ResolvedClientContext, catalogRef: string): Promise<CatalogSkill> {
  const ref = catalogRef.trim();
  if (!ref) {
    throw new Error("Catalog skill reference is required.");
  }
  const detail = await ctx.api.get<CatalogSkill>(`/api/skills/catalog/ref?ref=${encodeURIComponent(ref)}`);
  if (!detail) {
    throw new Error(`Catalog skill not found: ${catalogRef}`);
  }
  return detail;
}

export function resolveCompanySkillReference(
  skills: CompanySkillReferenceTarget[],
  reference: string,
): CompanySkillReferenceTarget {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("Skill reference is required.");
  }

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) return byId;

  const byKey = skills.find((skill) => skill.key === trimmed);
  if (byKey) return byKey;

  const normalizedSlug = normalizeSkillSlug(trimmed);
  const bySlug = skills.filter((skill) => skill.slug === normalizedSlug);
  if (bySlug.length === 1 && bySlug[0]) return bySlug[0];
  if (bySlug.length > 1) {
    throw new Error(`Ambiguous skill slug "${trimmed}". Use a skill ID or key instead.`);
  }

  throw new Error(`Skill not found: ${reference}`);
}

async function resolveCompanySkill(
  ctx: ResolvedClientContext,
  reference: string,
): Promise<CompanySkillReferenceTarget> {
  return resolveCompanySkillReference(await listCompanySkills(ctx), reference);
}

async function checkCompanySkills(
  ctx: ResolvedClientContext,
  skillRef: string | undefined,
): Promise<CompanySkillCheckRow[]> {
  const skills = await listCompanySkills(ctx);
  const selected = skillRef ? [resolveCompanySkillReference(skills, skillRef)] : skills;
  const rows: CompanySkillCheckRow[] = [];
  for (const skill of selected) {
    const status = await ctx.api.get<CompanySkillUpdateStatus>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/update-status`,
    );
    if (!status) {
      throw new Error(`No update status returned for skill ${skill.key}.`);
    }
    rows.push({ skill: toSkillReferenceTarget(skill), status });
  }
  return rows;
}

async function updateOneCompanySkill(
  ctx: ResolvedClientContext,
  skillRef: string,
  opts: SkillUpdateOptions = {},
): Promise<CompanySkillUpdateRow> {
  const skill = await resolveCompanySkill(ctx, skillRef);
  const updated = await ctx.api.post<CompanySkill>(
    `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/install-update`,
    { force: opts.force || undefined },
  );
  return {
    skillRef,
    action: "updated",
    skill: updated ?? undefined,
  };
}

async function updateAllCompanySkills(ctx: ResolvedClientContext, opts: SkillUpdateOptions = {}): Promise<CompanySkillUpdateRow[]> {
  const checks = await checkCompanySkills(ctx, undefined);
  const rows: CompanySkillUpdateRow[] = [];
  for (const row of checks) {
    if (!row.status.supported) {
      rows.push({
        skillRef: row.skill.key,
        action: "skipped",
        status: row.status,
        reason: row.status.reason ?? "Update checks are not supported for this skill.",
      });
      continue;
    }
    if (!row.status.hasUpdate) {
      rows.push({
        skillRef: row.skill.key,
        action: "skipped",
        status: row.status,
        reason: "Already current.",
      });
      continue;
    }
    try {
      const updated = await ctx.api.post<CompanySkill>(
        `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(row.skill.id)}/install-update`,
        { force: opts.force || undefined },
      );
      rows.push({
        skillRef: row.skill.key,
        action: "updated",
        status: row.status,
        skill: updated ?? undefined,
      });
    } catch (err) {
      rows.push({
        skillRef: row.skill.key,
        action: "failed",
        status: row.status,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

async function auditCompanySkills(
  ctx: ResolvedClientContext,
  skillRef: string | undefined,
): Promise<Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }>> {
  const skills = await listCompanySkills(ctx);
  const selected = skillRef ? [resolveCompanySkillReference(skills, skillRef)] : skills;
  const rows: Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }> = [];
  for (const skill of selected) {
    const audit = await ctx.api.post<CompanySkillAuditResult>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/audit`,
      {},
    );
    if (!audit) {
      throw new Error(`No audit result returned for skill ${skill.key}.`);
    }
    rows.push({ skill: toSkillReferenceTarget(skill), audit });
  }
  return rows;
}

async function resolveAgent(ctx: ResolvedClientContext, agentRef: string): Promise<Agent> {
  const params = new URLSearchParams({ companyId: ctx.companyId ?? "" });
  const agent = await ctx.api.get<Agent>(`/api/agents/${encodeURIComponent(agentRef)}?${params.toString()}`);
  if (!agent) {
    throw new Error(`Agent not found: ${agentRef}`);
  }
  return agent;
}

function printCompanySkillRows(rows: Array<CompanySkillListItem | CompanySkill>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.id,
        key: row.key,
        slug: row.slug,
        name: row.name,
        source: "sourceBadge" in row ? row.sourceBadge : row.sourceType,
        trust: row.trustLevel,
        compatibility: row.compatibility,
        attachedAgents: "attachedAgentCount" in row ? row.attachedAgentCount : undefined,
      }),
    );
  }
}

function printCatalogSkillRows(rows: CatalogSkill[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  printTable(rows.map((row) => ({
    id: row.id,
    key: row.key,
    kind: row.kind,
    category: row.category,
    slug: row.slug,
    name: row.name,
    trust: row.trustLevel,
    roles: row.recommendedForRoles.join(",") || "-",
  })));
}

function printCatalogSkillDetail(skill: CatalogSkill): void {
  console.log(
    formatInlineRecord({
      id: skill.id,
      key: skill.key,
      kind: skill.kind,
      category: skill.category,
      slug: skill.slug,
      name: skill.name,
      trust: skill.trustLevel,
      compatibility: skill.compatibility,
      contentHash: skill.contentHash,
    }),
  );
  console.log(`description=${skill.description || "-"}`);
  console.log(`recommendedForRoles=${skill.recommendedForRoles.join(",") || "-"}`);
  console.log(`tags=${skill.tags.join(",") || "-"}`);
  console.log("files:");
  printTable(skill.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  })));
}

function printCatalogInstallResult(result: CompanySkillInstallCatalogResult | null): void {
  if (!result) {
    console.log("Catalog install returned no result.");
    return;
  }
  console.log(
    `Catalog skill ${result.action}: ${result.skill.name} (${result.skill.key}) in company skill library.`,
  );
  console.log(
    "This does not attach the skill to an agent. Use `paperclipai skills agent sync <agent> --skill <skill>` when you want an agent to use it.",
  );
  for (const warning of result.warnings) {
    console.log(`warning=${warning}`);
  }
}

function printCompanySkillCheckRows(rows: CompanySkillCheckRow[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.skill.id,
        key: row.skill.key,
        slug: row.skill.slug,
        name: row.skill.name,
        supported: row.status.supported,
        hasUpdate: row.status.hasUpdate,
        currentRef: row.status.currentRef,
        latestRef: row.status.latestRef,
        installedHash: row.status.installedHash,
        originHash: row.status.originHash,
        hold: row.status.updateHoldReason,
        audit: row.status.auditVerdict,
        reason: row.status.reason,
      }),
    );
  }
}

function printCompanySkillAuditRows(rows: Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.skill.id,
        key: row.skill.key,
        slug: row.skill.slug,
        verdict: row.audit.verdict,
        installedHash: row.audit.installedHash,
        originHash: row.audit.originHash,
        codes: row.audit.codes.join(",") || null,
      }),
    );
    for (const finding of row.audit.findings) {
      console.log(
        formatInlineRecord({
          severity: finding.severity,
          code: finding.code,
          path: finding.path,
          message: finding.message,
        }),
      );
    }
  }
}

function printCompanySkillUpdateRows(rows: CompanySkillUpdateRow[]): void {
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        action: row.action,
        skillRef: row.skillRef,
        key: row.skill?.key,
        slug: row.skill?.slug,
        hasUpdate: row.status?.hasUpdate,
        reason: row.reason,
      }),
    );
  }
}

function printAgentSkillSnapshot(snapshot: AgentSkillSnapshot | null, agent: Agent): void {
  if (!snapshot) {
    console.log(`Agent ${agent.name} (${agent.id}) returned no skill snapshot.`);
    return;
  }
  console.log(
    `Agent ${agent.name} (${agent.id}) adapter=${snapshot.adapterType} supported=${snapshot.supported} mode=${snapshot.mode} desiredCompanySkills=${snapshot.desiredSkills.length}`,
  );
  if (snapshot.warnings.length > 0) {
    for (const warning of snapshot.warnings) {
      console.log(`warning=${warning}`);
    }
  }
  if (snapshot.entries.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const entry of snapshot.entries) {
    console.log(
      formatInlineRecord({
        key: entry.key,
        runtimeName: entry.runtimeName,
        desired: entry.desired,
        managed: entry.managed,
        state: entry.state,
        origin: entry.origin,
        detail: entry.detail,
      }),
    );
  }
}

function toSkillReferenceTarget(skill: CompanySkillReferenceTarget): CompanySkillReferenceTarget {
  return {
    id: skill.id,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
  };
}

function normalizeSkillSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function requireSkillRef(skillRef: string | undefined): string {
  if (!skillRef?.trim()) {
    throw new Error("Skill reference is required unless --all is used.");
  }
  return skillRef;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function emptyToUndefined(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function appendQueryParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  const widths = new Map(columns.map((column) => [column, column.length]));
  for (const row of rows) {
    for (const column of columns) {
      widths.set(column, Math.max(widths.get(column) ?? 0, renderTableValue(row[column]).length));
    }
  }
  console.log(columns.map((column) => column.padEnd(widths.get(column) ?? column.length)).join("  "));
  console.log(columns.map((column) => "-".repeat(widths.get(column) ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(
      columns
        .map((column) => renderTableValue(row[column]).padEnd(widths.get(column) ?? column.length))
        .join("  "),
    );
  }
}

function renderTableValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function readBodyFile(filePath: string): Promise<string> {
  if (filePath === "-") {
    return readStdin();
  }
  return readFile(filePath, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function confirmDangerousAction(yes: boolean | undefined, message: string): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This command requires --yes when not running in an interactive terminal.");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${message} Type yes to continue: `)).trim().toLowerCase();
    if (answer !== "yes") {
      throw new Error("Aborted.");
    }
  } finally {
    rl.close();
  }
}
