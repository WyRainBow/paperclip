import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

export interface ParsedQoderToolCall {
  id: string | null;
  name: string;
  input: unknown;
}

export interface ParsedQoderStream {
  sessionId: string | null;
  model: string;
  costUsd: number | null;
  usage: UsageSummary | null;
  summary: string;
  toolCalls: ParsedQoderToolCall[];
  errorMessage: string | null;
  resultJson: Record<string, unknown> | null;
}

/**
 * Sum the per-model usage ledger from a Qoder CLI result event. Same accounting
 * as the Claude Code protocol it implements: modelUsage is authoritative for
 * this invocation; cache-creation tokens count as input.
 */
function modelUsageTotals(modelUsage: unknown): UsageSummary | null {
  const byModel = parseObject(modelUsage);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawEntry = false;
  for (const value of Object.values(byModel)) {
    const entry = parseObject(value);
    if (Object.keys(entry).length === 0) continue;
    sawEntry = true;
    inputTokens += asNumber(entry.inputTokens, 0) + asNumber(entry.cacheCreationInputTokens, 0);
    outputTokens += asNumber(entry.outputTokens, 0);
    cachedInputTokens += asNumber(entry.cacheReadInputTokens, 0);
  }
  if (!sawEntry) return null;
  return { inputTokens, outputTokens, cachedInputTokens };
}

function extractErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const msg =
      asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) messages.push(msg);
  }
  return messages;
}

/**
 * Parse `qoder -p ... --output-format stream-json` stdout. Verified against
 * qodercli 1.1.3: the event schema is the Claude Code stream-json protocol
 * (system/init, assistant message content blocks, user tool_result, result).
 */
export function parseQoderStreamJson(stdout: string): ParsedQoderStream {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  const toolCalls: ParsedQoderToolCall[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      model = asString(message.model, model);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        const blockType = asString(block.type, "");
        if (blockType === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        } else if (blockType === "tool_use") {
          const name = asString(block.name, "").trim();
          if (!name) continue;
          toolCalls.push({
            id: asString(block.id, "").trim() || null,
            name,
            input: block.input ?? {},
          });
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null,
      usage: null,
      summary: assistantTexts.join("\n\n").trim(),
      toolCalls,
      errorMessage: null,
      resultJson: null,
    };
  }

  const totals = modelUsageTotals(finalResult.modelUsage);
  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = totals ?? {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  const failed =
    asBoolean(finalResult.is_error, false) ||
    asString(finalResult.subtype, "").trim().toLowerCase().startsWith("error");
  const errors = extractErrorMessages(finalResult);
  const errorMessage = failed
    ? asString(finalResult.result, "").trim() || errors[0] || `Qoder run failed (subtype=${asString(finalResult.subtype, "unknown")})`
    : null;

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    toolCalls,
    errorMessage,
    resultJson: finalResult,
  };
}

export function isQoderUnknownSessionError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  const messages = [
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractErrorMessages(parsed) : []),
    input.stderr ?? "",
  ]
    .map((msg) => msg.trim())
    .filter(Boolean);
  return messages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found|--resume requires a valid session|does not match any session/i.test(
      msg,
    ),
  );
}

const QODER_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|requires\s+login|\bqoder\s+login\b|unauthorized|\b401\b|authentication\s+(?:required|failed))/i;

export function isQoderAuthRequired(input: { stdout?: string | null; stderr?: string | null }): boolean {
  return `${input.stdout ?? ""}\n${input.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => QODER_AUTH_REQUIRED_RE.test(line));
}

export function describeQoderFailure(input: {
  errorMessage?: string | null;
  stderr?: string | null;
}): string | null {
  const detail =
    (typeof input.errorMessage === "string" ? input.errorMessage.trim() : "") ||
    (input.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ||
    "";
  if (!detail) return null;
  const clean = detail.replace(/\s+/g, " ").trim();
  const max = 240;
  return `Qoder run failed: ${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}`;
}
