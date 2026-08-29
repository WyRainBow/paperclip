import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readConfigEnv(config: Record<string, unknown>): Record<string, unknown> {
  return typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
    ? (config.env as Record<string, unknown>)
    : {};
}

/**
 * Resolve the Qoder user skills home, honoring QODER_CONFIG_DIR /
 * QODERCN_CONFIG_DIR (adapter config env first, then the server process env)
 * and falling back to ~/.qoder/skills.
 */
function resolveQoderSkillsHome(config: Record<string, unknown>): string {
  const env = readConfigEnv(config);
  const configDir =
    asString(env.QODER_CONFIG_DIR) ??
    asString(process.env.QODER_CONFIG_DIR) ??
    asString(env.QODERCN_CONFIG_DIR) ??
    asString(process.env.QODERCN_CONFIG_DIR);
  if (configDir) return path.join(path.resolve(configDir), "skills");
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".qoder", "skills");
}

async function buildQoderSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveQoderSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "qoder_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.qoder/skills",
    missingDetail: "Configured but not currently linked into the Qoder skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listQoderSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildQoderSkillSnapshot(ctx.config);
}

export async function syncQoderSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveQoderSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildQoderSkillSnapshot(ctx.config);
}
