import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  resolvePaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
  runChildProcess,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeQoderFailure,
  isQoderUnknownSessionError,
  parseQoderStreamJson,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// A Paperclip server started from inside a Qoder session inherits this var,
// which makes qodercli refuse to start unless the full SDK flag trio is given.
// Blank it so plain `-p --output-format stream-json` runs work (verified: the
// CLI treats an empty value as unset).
const QODER_SDK_ENTRYPOINT_VAR = "QODER_AGENT_SDK_ENTRYPOINT";

function buildQoderHeadlessEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  if (!next.NO_COLOR?.trim()) next.NO_COLOR = "1";
  if (!next.TERM?.trim()) next.TERM = "dumb";
  next[QODER_SDK_ENTRYPOINT_VAR] = "";
  return next;
}

/**
 * Qoder discovers project skills under `<dir>/.agents/skills` for every
 * workspace dir, including --add-dir extras. Symlink the desired Paperclip
 * skills into a per-run tmpdir so the agent cwd stays clean.
 */
async function buildQoderSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-qoder-skills-"));
  const target = path.join(tmp, ".agents", "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return tmp;
}

function createEventForwardingLog(
  onLog: AdapterExecutionContext["onLog"],
  onEvent: AdapterExecutionContext["onEvent"],
): { log: AdapterExecutionContext["onLog"]; flush: () => Promise<void> } {
  if (!onEvent) return { log: onLog, flush: async () => {} };
  let buffer = "";
  const emitLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    const event = parseQoderStreamJson(line);
    if (event.toolCalls.length > 0) {
      const call = event.toolCalls[event.toolCalls.length - 1];
      if (call) await onEvent({ eventType: "tool_call", stream: "stdout", payload: { toolName: call.name } });
    }
    if (event.summary) {
      await onEvent({ eventType: "assistant", stream: "stdout", message: event.summary, payload: { content: event.summary } });
    }
  };
  return {
    log: async (stream, chunk) => {
      await onLog(stream, chunk);
      if (stream !== "stdout") return;
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(0 + newlineIndex + 1);
        await emitLine(line);
      }
    },
    flush: async () => {
      const remaining = buffer;
      buffer = "";
      await emitLine(remaining);
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } = ctx;

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "qoder");
  const model = asString(config.model, "").trim();
  const permissionMode = asString(config.permissionMode, "bypass_permissions").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId: asString(workspaceContext.workspaceId, ""),
    workspaceRepoUrl: asString(workspaceContext.repoUrl, ""),
    workspaceRepoRef: asString(workspaceContext.repoRef, ""),
    workspaceHints: Array.isArray(context.paperclipWorkspaces)
      ? context.paperclipWorkspaces.filter(
          (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
        )
      : [],
    agentHome: asString(workspaceContext.agentHome, ""),
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (key === "PAPERCLIP_API_KEY") continue;
    env[key] = value;
  }
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...buildQoderHeadlessEnv(env) })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, skillEntries);
  let skillsTmpDir: string | null = null;
  if (desiredSkillNames.length > 0) {
    skillsTmpDir = await buildQoderSkillsDir(config);
    await onLog(
      "stderr",
      `[paperclip] Prepared ${desiredSkillNames.length} Qoder skill(s) via --add-dir delivery.\n`,
    );
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Qoder session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${path.dirname(instructionsFilePath)}/.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--output-format", "stream-json"];
    if (resumeSessionId) args.push("-r", resumeSessionId);
    if (model) args.push("-m", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (skillsTmpDir) args.push("--add-dir", skillsTmpDir);
    if (instructionsFilePath) args.push("--add-dir", path.dirname(instructionsFilePath));
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("-p", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    const loggedEnv = buildInvocationEnvForLogs(runtimeEnv, { resolvedCommand: command });
    if (onMeta) {
      await onMeta({
        adapterType: "qoder_local",
        command,
        cwd,
        commandNotes: [
          "Prompt is passed to Qoder via -p for non-interactive execution.",
          "Added --output-format stream-json for structured headless output.",
          `Permission mode: ${permissionMode}.`,
          `${QODER_SDK_ENTRYPOINT_VAR} is blanked so a Qoder-inherited server env cannot trip the CLI SDK-args guard.`,
        ],
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: loggedEnv,
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }

    const eventForwarder = createEventForwardingLog(onLog, onEvent);
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: eventForwarder.log,
    });
    await eventForwarder.flush();
    return { proc, parsed: parseQoderStreamJson(proc.stdout) };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; parsed: ReturnType<typeof parseQoderStreamJson> },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const failed = attempt.proc.exitCode === null || attempt.proc.exitCode !== 0;
    const fallbackErrorMessage =
      attempt.parsed.errorMessage ||
      describeQoderFailure({ stderr: attempt.proc.stderr }) ||
      (attempt.proc.signal
        ? `Qoder was terminated by signal ${attempt.proc.signal}`
        : `Qoder exited with code ${attempt.proc.exitCode ?? -1}`);

    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId || runtime.sessionId || null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? { sessionId: resolvedSessionId, cwd }
      : null;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "qoder",
      model: attempt.parsed.model || model || null,
      costUsd: attempt.parsed.costUsd,
      usage: attempt.parsed.usage ?? undefined,
      resultJson: {
        toolCalls: attempt.parsed.toolCalls,
        ...(failed ? { stderr: attempt.proc.stderr } : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isQoderUnknownSessionError({ parsed: initial.parsed.resultJson, stdout: initial.proc.stdout, stderr: initial.proc.stderr })
    ) {
      await onLog(
        "stdout",
        `[paperclip] Qoder resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }
    return toResult(initial);
  } finally {
    if (skillsTmpDir) {
      await fs.rm(skillsTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
