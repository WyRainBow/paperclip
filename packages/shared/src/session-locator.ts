/**
 * Where each terminal harness keeps its session id and its transcript (MUL-175).
 *
 * Four harnesses, four different answers, and until now the CLI only asked one
 * question — an environment variable — with a list that was two-thirds wrong:
 * `CODEX_SESSION_ID` and `ZCODE_SESSION_ID` are read in four places and neither
 * is exported by anything (Codex exports `CODEX_THREAD_ID`; ZCode exports no
 * session variable at all). Cards filed from those two silently recorded no
 * session.
 *
 * Verified on this machine 2026-08-31 by reading real files, not docs.
 *
 * Deliberately the single source of truth: the server publishes these on the
 * agent read model so the agents list and external collectors (MUL-173's
 * transcript scraper) read the same table the CLI resolves against, rather than
 * a copy in the database that would drift the first time a harness moved.
 */

/** Slugs match `detectTerminalSlug()` in the CLI so one lookup serves both. */
export type TerminalSlug = "claude-terminal" | "codex-terminal" | "zcode-terminal" | "qoder";

/**
 * How a path template turns a working directory into a directory name.
 *
 * `claude-style` replaces every `/` and every non-ASCII character with a single
 * `-`, which is lossy: `/Users/mac/开源工具/paperclip` becomes
 * `-Users-mac------paperclip` and cannot be reversed. Read `cwdField` out of the
 * transcript instead of trying to decode a slug.
 */
export type SlugRule = "claude-style" | "none";

export interface SessionLocator {
  slug: TerminalSlug;
  /** Display name, matching how the harness is written in Team Rules. */
  label: string;
  /**
   * Environment variable carrying the session id, or null when the harness
   * exports none and the id has to come from `indexPath` or the transcript.
   */
  sessionIdEnv: string | null;
  /**
   * Transcript location. `<cwdSlug>`, `<sessionId>` and `<date>` are the only
   * placeholders; `<date>` is `YYYY/MM/DD`.
   */
  transcriptPathTemplate: string;
  slugRule: SlugRule;
  /** Sqlite index listing sessions, for harnesses whose directory is flat. */
  indexPath: string | null;
  /** Where the real working directory is recorded inside the transcript. */
  cwdField: string;
  /** One line on anything a reader would otherwise get wrong. */
  note: string;
}

export const SESSION_LOCATORS: Record<TerminalSlug, SessionLocator> = {
  "claude-terminal": {
    slug: "claude-terminal",
    label: "Claude（Terminal）",
    sessionIdEnv: "CLAUDE_CODE_SESSION_ID",
    transcriptPathTemplate: "~/.claude/projects/<cwdSlug>/<sessionId>.jsonl",
    slugRule: "claude-style",
    indexPath: null,
    cwdField: "cwd",
    note: "The transcript follows the session's current working directory and leaves no copy behind: a session that moves into a worktree has its jsonl relocated under the new cwd's slug, so a path built from an older cwd finds nothing. Hook payloads carry session_id and transcript_path directly, which is why they beat rebuilding the path.",
  },
  "codex-terminal": {
    slug: "codex-terminal",
    label: "Codex（Terminal）",
    // Only workspace-write / full-access sessions export it; sandboxed Bash
    // gets CODEX_SANDBOX instead and no session id.
    sessionIdEnv: "CODEX_THREAD_ID",
    transcriptPathTemplate: "~/.codex/sessions/<date>/rollout-<timestamp>-<sessionId>.jsonl",
    slugRule: "none",
    indexPath: null,
    cwdField: "session_meta.payload.cwd",
    note: "Filename embeds an ISO timestamp before the id, so match on the id suffix rather than building the whole name.",
  },
  "zcode-terminal": {
    slug: "zcode-terminal",
    label: "Zcode（Terminal）",
    sessionIdEnv: null,
    transcriptPathTemplate: "~/.zcode/cli/rollout/model-io-<sessionId>.jsonl",
    slugRule: "none",
    indexPath: "~/.zcode/v2/tasks-index.sqlite",
    cwdField: "tasks.workspace_path",
    note: "Session ids look like sess_<uuid>. The rollout directory is flat across projects, so the sqlite index is the only way to scope by workspace.",
  },
  qoder: {
    slug: "qoder",
    label: "Qoder",
    sessionIdEnv: null,
    transcriptPathTemplate: "~/.qoder/projects/<cwdSlug>/<sessionId>.jsonl",
    slugRule: "claude-style",
    indexPath: null,
    cwdField: "workspace-directories.directories[0]",
    note: "No environment variable at all; the id appears only inside the transcript, so a Qoder session must be located by directory listing.",
  },
};

/**
 * Same transform Claude Code and Qoder apply to a cwd to name its directory:
 * every character that is not a letter, digit, or `-` becomes a single `-`.
 *
 * Dots go too — verified against a real worktree, whose `.claude` segment is
 * stored as `-claude`, giving `--claude-worktrees-…` with the doubled dash.
 * Underscores are likewise replaced, so the result is not reversible; read
 * `cwdField` out of the transcript when the real path matters.
 */
export function cwdSlug(absolutePath: string): string {
  return absolutePath.replace(/[^A-Za-z0-9-]/g, "-");
}

export function sessionLocatorForSlug(slug: string | null | undefined): SessionLocator | null {
  if (!slug) return null;
  return SESSION_LOCATORS[slug as TerminalSlug] ?? null;
}

/**
 * The session id for the harness we are running under, read from its own
 * environment variable. Null means "this harness does not publish one", which
 * is a different fact from "there is no session" — callers should say so rather
 * than record an empty slot.
 */
export function sessionIdFromEnv(
  slug: string | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  const locator = sessionLocatorForSlug(slug);
  if (!locator?.sessionIdEnv) return null;
  return env[locator.sessionIdEnv]?.trim() || null;
}
