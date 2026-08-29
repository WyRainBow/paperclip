// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuePropertiesProgressTab } from "./IssuePropertiesProgressTab";

const note = {
  id: "comment-1",
  authorAgentId: "agent-claude",
  authorUserId: null,
  body: "## 收尾\n\n- 一件事\n- 另一件事",
  presentation: { kind: "progress_note" },
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
};

const boardNote = {
  id: "comment-2",
  authorAgentId: null,
  authorUserId: "local-board",
  body: "board wrote this",
  presentation: { kind: "progress_note" },
  createdAt: new Date("2026-08-28T00:01:00.000Z"),
};

const systemNote = {
  id: "comment-3",
  authorAgentId: null,
  authorUserId: null,
  authorType: "system",
  body: "收卡登记提醒：MUL-149 未登记工作分支。",
  presentation: { kind: "progress_note" },
  createdAt: new Date("2026-08-28T00:02:00.000Z"),
};

const agents = [
  { id: "agent-claude", name: "Claude（Terminal）", icon: "sparkles", metadata: null },
];

const userDirectory = {
  users: [
    { principalId: "local-board", user: { name: "cocoyu", email: null } },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = JSON.stringify(queryKey);
    if (key.includes("agent")) return { data: agents, isLoading: false };
    if (key.includes("directory")) return { data: userDirectory, isLoading: false };
    return { data: [note, boardNote, systemNote], isLoading: false };
  },
}));
vi.mock("@/api/issues", () => ({ issuesApi: { listComments: vi.fn() } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: vi.fn() } }));
vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    issues: { comments: () => ["issues", "comments"] },
    agents: { list: () => ["agents", "list"] },
    access: { companyUserDirectory: () => ["access", "directory"] },
  },
}));
vi.mock("@/components/AgentIconPicker", () => ({
  AgentIcon: ({ icon }: { icon?: string | null }) => <span data-testid="agent-icon" data-icon={icon} />,
  agentCustomIcon: () => null,
}));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function render() {
  const root = createRoot(container);
  act(() => root.render(<IssuePropertiesProgressTab issueId="issue-1" companyId="company-1" />));
  return root;
}

describe("IssuePropertiesProgressTab", () => {
  it("shows the writing agent's own icon so the ledger reads as who-did-what", () => {
    const root = render();

    const icons = container.querySelectorAll('[data-testid="agent-icon"]');
    // One per agent-authored note; the board entry keeps the generic pulse.
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute("data-icon")).toBe("sparkles");

    act(() => root.unmount());
  });

  it("renders note bodies as markdown instead of one pre-wrapped block", () => {
    const root = render();

    const bodies = container.querySelectorAll('[data-testid="markdown-body"]');
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.textContent).toContain("## 收尾");
    // The old renderer put the body in a plain <p> with whitespace-pre-wrap.
    expect(container.querySelector("p.whitespace-pre-wrap")).toBeNull();

    act(() => root.unmount());
  });

  it("names system-authored notes 'system' with the notice tag — never 'board' (MUL-150)", () => {
    const root = render();

    const text = container.textContent ?? "";
    expect(text).toContain("system");
    expect(text).toContain("系统通知");
    expect(text).not.toContain(">board<");

    act(() => root.unmount());
  });

  it("shows the human's profile name (cocoyu), not the bare role word", () => {
    const root = render();

    const text = container.textContent ?? "";
    expect(text).toContain("cocoyu");

    act(() => root.unmount());
  });
});
