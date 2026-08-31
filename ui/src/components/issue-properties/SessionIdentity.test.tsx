// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIdentity } from "./primitives";

const writeText = vi.fn(async () => {});

vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => writeText(text),
}));

vi.mock("@/components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "21b3ff91-58e5-43a8-8be5-7fc86836cdae";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  writeText.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Parameters<typeof SessionIdentity>[0]) {
  act(() => root.render(<SessionIdentity {...props} />));
  const button = container.querySelector("button");
  if (!button) throw new Error("session id chip did not render as a button");
  return button;
}

describe("SessionIdentity session id chip", () => {
  it("copies the Claude resume command for a Claude terminal session", async () => {
    const button = render({
      agentId: "agent-claude",
      agentName: "Claude（Terminal）",
      agentAdapterType: "http",
      userId: null,
      sessionId: SESSION,
    });
    expect(button.textContent).toBe(SESSION);
    expect(button.title).toBe(`claude --resume ${SESSION}`);

    await act(async () => { button.click(); });
    expect(writeText).toHaveBeenCalledWith(`claude --resume ${SESSION}`);
    expect(container.textContent).toContain("Copied");
  });

  it("copies the Codex resume command", async () => {
    const button = render({
      agentId: "agent-codex",
      agentName: "Codex（Terminal）",
      agentAdapterType: "codex_local",
      userId: null,
      sessionId: SESSION,
    });
    await act(async () => { button.click(); });
    expect(writeText).toHaveBeenCalledWith(`codex resume ${SESSION}`);
  });

  it("copies the bare id for a CLI with no known resume command", async () => {
    const button = render({
      agentId: "agent-qoder",
      agentName: "Qoder",
      agentAdapterType: "qoder_local",
      userId: null,
      sessionId: SESSION,
    });
    await act(async () => { button.click(); });
    expect(writeText).toHaveBeenCalledWith(SESSION);
  });
});
