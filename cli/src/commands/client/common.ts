import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import type { Command } from "commander";
import { getStoredBoardCredential, loginBoardCli } from "../../client/board-auth.js";
import { buildCliCommandLabel } from "../../client/command-label.js";
import { readConfig } from "../../config/store.js";
import { readContext, resolveProfile, type ClientContextProfile } from "../../client/context.js";
import { ApiRequestError, PaperclipApiClient } from "../../client/http.js";

export interface BaseClientOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  runId?: string;
  companyId?: string;
  json?: boolean;
}

export interface ResolvedClientContext {
  api: PaperclipApiClient;
  companyId?: string;
  profileName: string;
  profile: ClientContextProfile;
  json: boolean;
  authSource: "explicit" | "env" | "env_file" | "terminal" | "profile_env" | "stored_board" | "none";
}

export function addCommonClientOptions(command: Command, opts?: { includeCompany?: boolean }): Command {
  command
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL for the Paperclip API")
    .option("--api-key <token>", "Bearer token for agent-authenticated calls; falls back to $PAPERCLIP_API_KEY, then $PAPERCLIP_API_KEY_FILE, then this terminal's own key under ~/.paperclip/keys/")
    .option("--run-id <id>", "Heartbeat run id for agent-authenticated mutations (checkout/release/interactions/in-progress update); falls back to $PAPERCLIP_RUN_ID")
    .option("--json", "Output raw JSON");

  if (opts?.includeCompany) {
    command.option("-C, --company-id <id>", "Company ID (overrides context default)");
  }

  return command;
}

export function resolveCommandContext(
  options: BaseClientOptions,
  opts?: { requireCompany?: boolean },
): ResolvedClientContext {
  const context = readContext(options.context);
  const { name: profileName, profile } = resolveProfile(context, options.profile);

  const apiBase = resolveApiBase(options, profile);

  const resolvedApiKey = resolveApiKey(options, profile);
  const explicitApiKey = resolvedApiKey.value;
  const storedBoardCredential = explicitApiKey ? null : getStoredBoardCredential(apiBase);
  const apiKey = explicitApiKey || storedBoardCredential?.token;

  const companyId =
    options.companyId?.trim() ||
    process.env.PAPERCLIP_COMPANY_ID?.trim() ||
    profile.companyId;

  if (opts?.requireCompany && !companyId) {
    throw new Error(
      "Company ID is required. Pass --company-id, set PAPERCLIP_COMPANY_ID, or set context profile companyId via `paperclipai context set`.",
    );
  }

  // Agent-authenticated mutations (checkout, release, interactions, PATCH of an
  // in-progress issue) require the X-Paperclip-Run-Id header (the server returns
  // "401 Agent run id required" without it). Source it from --run-id, else the
  // PAPERCLIP_RUN_ID env the adapter/embodiment context already exports.
  const runId = options.runId?.trim() || process.env.PAPERCLIP_RUN_ID?.trim() || undefined;

  const api = new PaperclipApiClient({
    apiBase,
    apiKey,
    runId,
    recoverAuth: explicitApiKey || !canAttemptInteractiveBoardAuth()
      ? undefined
      : async ({ error }) => {
          const requestedAccess = error.message.includes("Instance admin required")
            ? "instance_admin_required"
            : "board";
          if (!shouldRecoverBoardAuth(error)) {
            return null;
          }
          const login = await loginBoardCli({
            apiBase,
            requestedAccess,
            requestedCompanyId: companyId ?? null,
            command: buildCliCommandLabel(),
          });
          return login.token;
        },
  });
  return {
    api,
    companyId,
    profileName,
    profile,
    json: Boolean(options.json),
    authSource: explicitApiKey ? resolvedApiKey.source : storedBoardCredential ? "stored_board" : "none",
  };
}

export function resolveApiBase(options: Pick<BaseClientOptions, "apiBase" | "config">, profile: ClientContextProfile = {}): string {
  return normalizeApiBase(
    options.apiBase?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    profile.apiBase ||
    inferApiBaseFromConfig(options.config),
  );
}

export function normalizeApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null | undefined>): string {
  let path = strings[0] ?? "";
  values.forEach((value, index) => {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Cannot build API path with an empty path segment.");
    }
    path += `${encodeURIComponent(String(value))}${strings[index + 1] ?? ""}`;
  });
  return path;
}

export function inferContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  // These MIME strings are matched against the server's issue-attachment
  // allowlist (server/src/attachment-types.ts DEFAULT_ALLOWED_TYPES) by EXACT
  // string, so text types must carry no "; charset=..." parameter or the upload
  // is rejected with "422 Unsupported attachment content type". Keep this set in
  // sync with that allowlist (plus svg/avif, accepted by the asset routes).
  return {
    avif: "image/avif",
    csv: "text/csv",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4v: "video/x-m4v",
    md: "text/markdown",
    mov: "video/quicktime",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    qt: "video/quicktime",
    svg: "image/svg+xml",
    txt: "text/plain",
    webm: "video/webm",
    webp: "image/webp",
    zip: "application/zip",
  }[ext];
}

/**
 * Which terminal is running us, inferred from the variables its own app exports
 * into every child process (MUL-113).
 *
 * Asking each terminal's config to inject the identity failed twice: ZCode's
 * settings.json `env` never reaches Bash children at all, and Codex does not
 * pass it to hook subprocesses, so both silently ran as local-board. These
 * signatures come from the app itself rather than from user config, so there is
 * nothing to configure per machine and nothing to drift.
 */
const TERMINAL_SIGNATURES: Array<{ slug: string; envVars: string[] }> = [
  { slug: "claude-terminal", envVars: ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR"] },
  { slug: "codex-terminal", envVars: ["CODEX_SANDBOX"] },
  { slug: "zcode-terminal", envVars: ["ZCODE_BASE_URL"] },
];

/** The terminal we appear to be running inside, or null in a plain shell. */
export function detectTerminalSlug(): string | null {
  for (const signature of TERMINAL_SIGNATURES) {
    if (signature.envVars.some((name) => (process.env[name] ?? "").trim() !== "")) return signature.slug;
  }
  return null;
}

export function terminalKeyPath(slug: string): string {
  return path.join(os.homedir(), ".paperclip", "keys", slug);
}

/**
 * Resolves this terminal's key from ~/.paperclip/keys/<slug> with no
 * configuration at all.
 *
 * A plain shell matches no signature and gets no identity, which is the point:
 * an unrecognized caller must never inherit somebody else's name. A recognized
 * terminal whose key file is missing is an error rather than a fallback, for
 * the same reason the env-file source is (see below).
 */
function readKeyFromTerminalDiscovery(): string | undefined {
  const slug = detectTerminalSlug();
  if (!slug) return undefined;

  const filePath = terminalKeyPath(slug);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This looks like a ${slug} session, but its key file could not be read: ${filePath} (${reason})\n` +
        "Refusing to fall back to an unauthenticated (local-board) request — mint the key in the UI and write it to that path.",
    );
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(
      `This looks like a ${slug} session, but its key file is empty: ${filePath}\n` +
        "Refusing to fall back to an unauthenticated (local-board) request.",
    );
  }

  warnOnLooseKeyFilePermissions(filePath);
  return value;
}

/**
 * Reads the key file named by PAPERCLIP_API_KEY_FILE.
 *
 * Failing loudly is the whole point of this source (MUL-104). The mechanism it
 * replaces — a zshenv branch that skipped itself when the key file was missing
 * — left Codex（Terminal） with no credentials for a day without anyone
 * noticing, because a credential-less CLI silently degrades to local-board and
 * keeps working under the wrong identity. So a file that is set but unusable is
 * a hard exit, never a fallback.
 */
function readKeyFromEnvFile(): string | undefined {
  const filePath = process.env.PAPERCLIP_API_KEY_FILE?.trim();
  if (!filePath) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PAPERCLIP_API_KEY_FILE is set to ${filePath} but the file could not be read: ${reason}\n` +
        "Refusing to fall back to an unauthenticated (local-board) request — mint the key in the UI and write it to that path.",
    );
  }

  // `echo` writes a trailing newline; an untrimmed key reaches the server as a
  // malformed bearer token and the 401 says nothing about whitespace.
  const value = raw.trim();
  if (!value) {
    throw new Error(
      `PAPERCLIP_API_KEY_FILE is set to ${filePath} but the file is empty.\n` +
        "Refusing to fall back to an unauthenticated (local-board) request.",
    );
  }

  warnOnLooseKeyFilePermissions(filePath);
  return value;
}

/** A key readable by group or others is a leak waiting to happen, but it still
 *  works, so this warns instead of blocking. */
function warnOnLooseKeyFilePermissions(filePath: string): void {
  try {
    const mode = fs.statSync(filePath).mode & 0o077;
    if (mode !== 0) {
      console.error(
        pc.yellow(
          `warning: ${filePath} is readable by group/other (mode ${(fs.statSync(filePath).mode & 0o777).toString(8)}); run \`chmod 600 ${filePath}\``,
        ),
      );
    }
  } catch {
    // Permission reporting is best-effort; the key already read fine.
  }
}

function resolveApiKey(
  options: Pick<BaseClientOptions, "apiKey">,
  profile: ClientContextProfile,
): { value: string | undefined; source: "explicit" | "env" | "env_file" | "terminal" | "profile_env" | "none" } {
  const optionValue = options.apiKey?.trim();
  if (optionValue) return { value: optionValue, source: "explicit" };

  const envValue = process.env.PAPERCLIP_API_KEY?.trim();
  if (envValue) return { value: envValue, source: "env" };

  const envFileValue = readKeyFromEnvFile();
  if (envFileValue) return { value: envFileValue, source: "env_file" };

  const terminalValue = readKeyFromTerminalDiscovery();
  if (terminalValue) return { value: terminalValue, source: "terminal" };

  const profileEnvValue = readKeyFromProfileEnv(profile);
  if (profileEnvValue) return { value: profileEnvValue, source: "profile_env" };

  return { value: undefined, source: "none" };
}

function shouldRecoverBoardAuth(error: ApiRequestError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  return error.message.includes("Board access required") || error.message.includes("Instance admin required");
}

function canAttemptInteractiveBoardAuth(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printOutput(data: unknown, opts: { json?: boolean; label?: string } = {}): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts.label) {
    console.log(pc.bold(opts.label));
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(pc.dim("(empty)"));
      return;
    }
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        console.log(formatInlineRecord(item as Record<string, unknown>));
      } else {
        console.log(String(item));
      }
    }
    return;
  }

  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data === undefined || data === null) {
    console.log(pc.dim("(null)"));
    return;
  }

  console.log(String(data));
}

export function formatInlineRecord(record: Record<string, unknown>): string {
  const keyOrder = ["identifier", "id", "name", "status", "priority", "title", "action"];
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keyOrder) {
    if (!(key in record)) continue;
    parts.push(`${key}=${renderValue(record[key])}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(record)) {
    if (seen.has(key)) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.join(" ");
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[object]";
}

export function inferApiBaseFromConfig(configPath?: string): string {
  const envHost = process.env.PAPERCLIP_SERVER_HOST?.trim() || "localhost";
  let port = Number(process.env.PAPERCLIP_SERVER_PORT || "");

  if (!Number.isFinite(port) || port <= 0) {
    try {
      const config = readConfig(configPath);
      port = Number(config?.server?.port ?? 3100);
    } catch {
      port = 3100;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    port = 3100;
  }

  return `http://${envHost}:${port}`;
}

function readKeyFromProfileEnv(profile: ClientContextProfile): string | undefined {
  if (!profile.apiKeyEnvVarName) return undefined;
  return process.env[profile.apiKeyEnvVarName]?.trim() || undefined;
}

export function handleCommandError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    const detailSuffix = error.details !== undefined ? ` details=${JSON.stringify(error.details)}` : "";
    console.error(pc.red(`API error ${error.status}: ${error.message}${detailSuffix}`));
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}


/**
 * 决策正文死模板（MUL-49 收口）：背景 / 判断标准 / 方案 三节缺一不可。
 * Server-side the inputs (裁决理由) are locked; the body sections stayed
 * advisory with zero consumers — "靠自觉" was the exact failure the template
 * existed to prevent. Enforced here at the CLI layer so the generic decision
 * service stays language-neutral. Accepts markdown headings ("## 背景") and
 * plain "背景：" line starts — the shape both real backfills already used.
 */
export function assertDecisionBodyTemplate(body: string): void {
  const sections = ["背景", "判断标准", "方案"] as const;
  const missing = sections.filter((section) =>
    !new RegExp(`^#{1,6}\\s*[0-9.、]*\\s*${section}`, "m").test(body)
    && !new RegExp(`^\\s*${section}\\s*[：:]`, "m").test(body));
  if (missing.length > 0) {
    throw new Error(
      `决策正文缺节：${missing.join("、")} —— 三段死模板（背景 / 判断标准 / 方案）缺一不可，每个方案带自己的代价`,
    );
  }
}
