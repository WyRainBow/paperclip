import { describe, expect, it } from "vitest";
import { sessionCliKind, sessionCopyText, sessionResumeCommand } from "./session-resume";

const CLAUDE_SESSION = "21b3ff91-58e5-43a8-8be5-7fc86836cdae";
const CODEX_SESSION = "584904ba-3c3e-49a7-a57d-25efa28836c7";

describe("sessionCliKind", () => {
  it("reads the adapter type first", () => {
    expect(sessionCliKind("claude_local", "Qoder")).toBe("claude");
    expect(sessionCliKind("codex_local", null)).toBe("codex");
  });

  it("falls back to the agent name for attribution-only terminal agents", () => {
    expect(sessionCliKind("http", "Claude（Terminal）")).toBe("claude");
    expect(sessionCliKind("http", "Codex（Terminal）")).toBe("codex");
  });

  it("returns null for CLIs with no known resume command", () => {
    expect(sessionCliKind("qoder_local", "Qoder")).toBeNull();
    expect(sessionCliKind(null, null)).toBeNull();
  });
});

describe("sessionResumeCommand", () => {
  it("builds the Claude command", () => {
    expect(sessionResumeCommand({ adapterType: "http", agentName: "Claude（Terminal）", sessionId: CLAUDE_SESSION }))
      .toBe(`claude --resume ${CLAUDE_SESSION}`);
  });

  it("builds the Codex command", () => {
    expect(sessionResumeCommand({ adapterType: "codex_local", agentName: "Codex（Terminal）", sessionId: CODEX_SESSION }))
      .toBe(`codex resume ${CODEX_SESSION}`);
  });

  it("refuses ids that are not uuids", () => {
    expect(sessionResumeCommand({ adapterType: "claude_local", agentName: null, sessionId: "sess_1ecef3b3" })).toBeNull();
    expect(sessionResumeCommand({ adapterType: "claude_local", agentName: null, sessionId: null })).toBeNull();
  });

  it("returns null for other agents", () => {
    expect(sessionResumeCommand({ adapterType: "qoder_local", agentName: "Qoder", sessionId: CODEX_SESSION })).toBeNull();
  });
});

describe("sessionCopyText", () => {
  it("copies the command when resumable and the bare id otherwise", () => {
    expect(sessionCopyText({ adapterType: "http", agentName: "Claude（Terminal）", sessionId: CLAUDE_SESSION }))
      .toBe(`claude --resume ${CLAUDE_SESSION}`);
    expect(sessionCopyText({ adapterType: "qoder_local", agentName: "Qoder", sessionId: CODEX_SESSION }))
      .toBe(CODEX_SESSION);
  });
});
