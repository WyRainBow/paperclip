import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { sessionLocatorForSlug, cwdSlug, type SessionLocator } from "@paperclipai/shared/session-locator";

/**
 * Read the model and reasoning effort this session is actually running at
 * (MUL-444).
 *
 * MUL-22 asked for the model to be written by hand on every decision card and
 * every review archive label. It drifted, which is why this card exists: a
 * value a human types is a value that gets typed wrong, forgotten, or copied
 * from the last card. Nothing publishes these as environment variables except
 * Claude's effort, so the only way to stop hand-writing them is to read the
 * harness's own record.
 *
 * Everything here is best-effort and local: a missing file, a moved transcript
 * or a harness that records nothing returns null with a reason. Callers show
 * the reason rather than substituting a plausible model name — a wrong model on
 * an old decision is worse than a blank one, because a blank prompts a question
 * and a wrong one does not.
 */

export interface LocalModelReading {
  model: string | null;
  effort: string | null;
  /** Why a field is null, for the caller to surface. Null when both were read. */
  reason: string | null;
}

const EMPTY = (reason: string): LocalModelReading => ({ model: null, effort: null, reason });

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Walk a dotted path, tolerating the missing keys these records are full of. */
function pluck(record: unknown, dotted: string): string | null {
  let cursor: unknown = record;
  for (const key of dotted.split(".")) {
    if (cursor == null || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : null;
}

/**
 * Resolve the transcript path for a session under this locator. Only the two
 * `<cwdSlug>`-shaped layouts can be built directly; Codex embeds a timestamp in
 * the filename and Zcode keeps a flat directory, so those are found by scan.
 */
function transcriptPath(locator: SessionLocator, sessionId: string, cwd: string): string | null {
  if (locator.slugRule === "claude-style") {
    const dir = expandHome(locator.transcriptPathTemplate).replace(/\/<cwdSlug>\/.*$/, "");
    return path.join(dir, cwdSlug(cwd), `${sessionId}.jsonl`);
  }
  if (locator.slug === "zcode-terminal") {
    return expandHome(locator.transcriptPathTemplate).replace("<sessionId>", sessionId);
  }
  return null;
}

/**
 * Scan a jsonl transcript for the last record of the wanted type and pull the
 * two fields out of it.
 *
 * Reads line by line rather than loading the file: a working session's
 * transcript reached 17 MB on this machine, and the values wanted are on the
 * newest records, so the whole file is never worth holding.
 */
async function readFromTranscript(file: string, locator: SessionLocator): Promise<LocalModelReading> {
  if (!existsSync(file)) return EMPTY(`transcript not found at ${file}`);
  let model: string | null = null;
  let effort: string | null = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof record.type === "string" ? record.type : null;
      if (locator.modelField && type === locator.modelField.record) {
        model = pluck(record, locator.modelField.path) ?? model;
      }
      if (locator.effortField && type === locator.effortField.record) {
        effort = pluck(record, locator.effortField.path) ?? effort;
      }
    }
  } finally {
    rl.close();
  }
  if (!model) return { model, effort, reason: `no ${locator.modelField?.record ?? "model"} record in ${file}` };
  return { model, effort, reason: effort ? null : "harness recorded no effort for this session" };
}

/**
 * Zcode keeps model and effort in its sqlite index rather than the rollout.
 * `node:sqlite` ships with the runtime, so this reads it without adding a
 * dependency for one query.
 */
async function readFromZcodeIndex(indexPath: string, sessionId: string): Promise<LocalModelReading> {
  const file = expandHome(indexPath);
  if (!existsSync(file)) return EMPTY(`zcode index not found at ${file}`);
  let DatabaseSync: new (p: string, o?: unknown) => { prepare: (q: string) => { get: (...a: unknown[]) => unknown }; close: () => void };
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: typeof DatabaseSync });
  } catch {
    return EMPTY("node:sqlite unavailable in this runtime");
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("select model, meta_json from tasks where task_id = ? limit 1").get(sessionId) as
      | { model?: string | null; meta_json?: string | null }
      | undefined;
    if (!row) return EMPTY(`no row for ${sessionId} in ${file}`);
    let effort: string | null = null;
    try {
      const meta = JSON.parse(row.meta_json ?? "{}") as { thoughtLevel?: unknown };
      if (typeof meta.thoughtLevel === "string" && meta.thoughtLevel.trim()) effort = meta.thoughtLevel.trim();
    } catch {
      // meta_json is the harness's own blob; a malformed one costs effort, not
      // the model, so it is not worth failing the whole read.
    }
    const model = row.model?.trim() || null;
    return { model, effort, reason: model ? (effort ? null : "index recorded no thoughtLevel") : "index row has no model" };
  } finally {
    db.close();
  }
}

/**
 * What model and effort is this session running at? `sessionId` and `cwd` come
 * from the caller because the CLI already resolves both (MUL-175).
 */
export async function readLocalModelSignature(
  slug: string | null | undefined,
  sessionId: string | null | undefined,
  cwd: string,
): Promise<LocalModelReading> {
  const locator = sessionLocatorForSlug(slug);
  if (!locator) return EMPTY("not running under a recognized terminal");
  if (!sessionId) return EMPTY("no session id to look the transcript up by");
  if (!locator.modelField) return EMPTY(`${locator.label} records no model`);

  if (locator.modelField.record === "tasks-index") {
    if (!locator.indexPath) return EMPTY(`${locator.label} has no index path`);
    return readFromZcodeIndex(locator.indexPath, sessionId);
  }
  const file = transcriptPath(locator, sessionId, cwd);
  if (!file) return EMPTY(`${locator.label} transcripts cannot be located by path alone — its filename embeds a timestamp`);
  return readFromTranscript(file, locator);
}
