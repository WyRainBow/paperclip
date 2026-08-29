import { describe, expect, it } from "vitest";
import {
  describeQoderFailure,
  isQoderUnknownSessionError,
  parseQoderStreamJson,
} from "./parse.js";

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  model: "qmodel_38max",
  session_id: "sess-123",
});

const ASSISTANT = JSON.stringify({
  type: "assistant",
  session_id: "sess-123",
  message: {
    model: "qmodel_38max",
    content: [
      { type: "thinking", thinking: "planning" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ],
  },
});

const ASSISTANT_TEXT = JSON.stringify({
  type: "assistant",
  session_id: "sess-123",
  message: { content: [{ type: "text", text: "done" }] },
});

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 0.01,
  session_id: "sess-123",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  modelUsage: {
    qmodel_38max: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
    },
  },
});

describe("parseQoderStreamJson", () => {
  it("captures session, model, usage and summary from the stream", () => {
    const parsed = parseQoderStreamJson([INIT, ASSISTANT, ASSISTANT_TEXT, RESULT].join("\n"));
    expect(parsed.sessionId).toBe("sess-123");
    expect(parsed.model).toBe("qmodel_38max");
    expect(parsed.summary).toBe("done");
    expect(parsed.costUsd).toBe(0.01);
    // modelUsage wins over the top-level usage ledger
    expect(parsed.usage).toEqual({
      inputTokens: 110,
      outputTokens: 50,
      cachedInputTokens: 20,
    });
    expect(parsed.toolCalls).toEqual([{ id: "tu_1", name: "Bash", input: { command: "ls" } }]);
    expect(parsed.errorMessage).toBeNull();
  });

  it("falls back to top-level usage when modelUsage is absent", () => {
    const parsed = parseQoderStreamJson(RESULT.replace('"modelUsage"', '"modelUsageUnused"'));
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
    });
  });

  it("reports failure results as errorMessage", () => {
    const failed = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "boom",
      errors: ["something broke"],
    });
    const parsed = parseQoderStreamJson(failed);
    expect(parsed.errorMessage).toBe("boom");
  });

  it("tolerates non-JSON lines", () => {
    const parsed = parseQoderStreamJson(`not json\n${RESULT}`);
    expect(parsed.summary).toBe("done");
  });
});

describe("isQoderUnknownSessionError", () => {
  it("detects stale resume sessions", () => {
    const parsed = { result: "No conversation found with session id: abc" };
    expect(isQoderUnknownSessionError({ parsed })).toBe(true);
    expect(isQoderUnknownSessionError({ parsed: { result: "done" } })).toBe(false);
  });
});

describe("describeQoderFailure", () => {
  it("prefers the parsed error message and truncates stderr", () => {
    expect(describeQoderFailure({ errorMessage: "boom" })).toBe("Qoder run failed: boom");
    expect(describeQoderFailure({ stderr: "x".repeat(300) })).toContain("…");
    expect(describeQoderFailure({})).toBeNull();
  });
});
