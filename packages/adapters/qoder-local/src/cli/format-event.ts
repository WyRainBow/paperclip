import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function snippet(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function printQoderStreamEvent(raw: string, debug: boolean): void {
  const event = asRecord(safeJsonParse(raw));
  if (!event) {
    if (debug) console.log(pc.gray(raw));
    return;
  }

  const type = typeof event.type === "string" ? event.type : "";

  if (type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? event.model : "unknown";
    const sessionId = typeof event.session_id === "string" ? event.session_id : "";
    console.log(pc.blue(`[qoder] init model=${model}${sessionId ? ` session=${sessionId}` : ""}`));
    return;
  }

  if (type === "assistant") {
    const message = asRecord(event.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text" && typeof block.text === "string" && block.text.trim()) {
        console.log(pc.green(`[qoder] ${snippet(block.text)}`));
      } else if (blockType === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        console.log(pc.yellow(`[qoder] tool ${name}`));
      } else if (blockType === "thinking" && debug && typeof block.thinking === "string" && block.thinking.trim()) {
        console.log(pc.magenta(`[qoder] thinking: ${snippet(block.thinking)}`));
      }
    }
    return;
  }

  if (type === "result") {
    const isError = event.is_error === true;
    const text = typeof event.result === "string" ? snippet(event.result) : "";
    const usage = asRecord(event.usage) ?? {};
    const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    console.log(
      (isError ? pc.red : pc.cyan)(
        `[qoder] result${isError ? " (error)" : ""} ${text} (in=${input} out=${output})`,
      ),
    );
    return;
  }

  if (debug) console.log(pc.gray(raw));
}
