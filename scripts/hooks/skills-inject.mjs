#!/usr/bin/env node
// PreToolUse(Skill) [paperclip] — hand the current turn the freshly pulled body.
//
// Claude Code serves skill content from a registry that a file watcher keeps up
// to date, and that watcher does not see writes inside a symlink target. Measured
// catch-up after an atomic relink was 5s-44s, so a skill pulled moments ago can
// still be served stale. Within TTL_SECONDS of a recorded change this injects the
// on-disk body and states that it wins; outside that window the registry has
// caught up and this is a no-op.
//
// Fail-open in every branch: invoking a skill must never break because this hook
// could not do its job.

import { readFile, lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const TTL_SECONDS = Number(process.env.PAPERCLIP_SKILLS_INJECT_TTL ?? 120);
const MAX_INJECT_BYTES = Number(process.env.PAPERCLIP_SKILLS_INJECT_MAX_BYTES ?? 60_000);
const SIDECAR = ".paperclip-skill.json";
const TEAM_SKILLS_DIRNAME = "skills-team";

function quit() {
  process.exit(0);
}

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: text,
      },
    }),
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function claudeSkillsHome() {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homedir(), ".claude");
  return path.join(base, "skills");
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf("\n", end + 1);
  return after === -1 ? "" : markdown.slice(after + 1);
}

const raw = await readStdin().catch(() => "");
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  quit();
}

const skillName = payload?.tool_input?.skill;
if (typeof skillName !== "string" || skillName.length === 0) quit();
if (skillName.includes("/") || skillName.includes("..")) quit();

const entry = path.join(claudeSkillsHome(), skillName);
const stat = await lstat(entry).catch(() => null);
if (!stat?.isSymbolicLink()) quit();

const link = await readlink(entry).catch(() => null);
if (!link) quit();
const targetDir = path.isAbsolute(link) ? link : path.resolve(path.dirname(entry), link);
if (!targetDir.split(path.sep).includes(TEAM_SKILLS_DIRNAME)) quit();

let sidecar;
try {
  sidecar = JSON.parse(await readFile(path.join(targetDir, SIDECAR), "utf8"));
} catch {
  quit();
}

const changedAt = Date.parse(sidecar?.lastChangedAt ?? "");
if (!Number.isFinite(changedAt)) quit();
if ((Date.now() - changedAt) / 1000 > TTL_SECONDS) quit();

let markdown;
try {
  markdown = await readFile(path.join(targetDir, "SKILL.md"), "utf8");
} catch {
  quit();
}

const body = stripFrontmatter(markdown).trim();
if (body.length === 0) quit();

if (Buffer.byteLength(body, "utf8") > MAX_INJECT_BYTES) {
  emit(
    `The skill "${skillName}" was updated in the Team Skills library moments ago and the copy the Skill tool just returned may be stale. It is too large to inline here. Read the current version from ${path.join(targetDir, "SKILL.md")} before acting on it.`,
  );
}

emit(
  `The skill "${skillName}" was updated in the Team Skills library moments ago. The body below is the current version read from disk and supersedes the copy the Skill tool returned in this turn.\n\n${body}`,
);
