/**
 * Turn a recorded session id into the command that reopens that session in a
 * terminal. Copying a bare uuid leaves the reader to remember which CLI it
 * belongs to and what that CLI's resume flag looks like, so the copy button
 * hands over the whole command instead.
 *
 * Only Claude and Codex have a known resume command today; everything else
 * copies the raw id.
 */

export type SessionCliKind = "claude" | "codex";

/** Both CLIs take a uuid. A runtime id in any other shape is not resumable. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The adapter type is authoritative when it names a CLI, but terminal agents
 * that only report attribution run on `http` and carry the CLI in their name
 * ("Claude（Terminal）"), so the name is the second read.
 */
export function sessionCliKind(
  adapterType: string | null | undefined,
  agentName: string | null | undefined,
): SessionCliKind | null {
  const adapter = (adapterType ?? "").toLowerCase();
  if (adapter === "claude_local") return "claude";
  if (adapter === "codex_local") return "codex";

  const name = (agentName ?? "").toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  return null;
}

/** `claude --resume <id>` / `codex resume <id>`, or null when not resumable. */
export function sessionResumeCommand({
  adapterType,
  agentName,
  sessionId,
}: {
  adapterType?: string | null;
  agentName?: string | null;
  sessionId: string | null | undefined;
}): string | null {
  const id = (sessionId ?? "").trim();
  if (!UUID.test(id)) return null;

  const kind = sessionCliKind(adapterType, agentName);
  if (kind === "claude") return `claude --resume ${id}`;
  if (kind === "codex") return `codex resume ${id}`;
  return null;
}

/** What the copy button writes: the resume command when there is one, else the id. */
export function sessionCopyText({
  adapterType,
  agentName,
  sessionId,
}: {
  adapterType?: string | null;
  agentName?: string | null;
  sessionId: string;
}): string {
  return sessionResumeCommand({ adapterType, agentName, sessionId }) ?? sessionId;
}
