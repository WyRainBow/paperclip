// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamRules } from "./TeamRules";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: mockApi,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

const NOTE = {
  id: "note-1",
  companyId: "company-1",
  title: "团队通用规则 · 实验室",
  body: "# 团队通用规则",
  position: 0,
  createdByUserId: null,
  createdByAgentId: null,
  createdAt: "2026-08-26T02:25:32.789Z",
  updatedAt: "2026-08-27T08:21:05.884Z",
  latestVersion: null,
};

const AGENT = {
  id: "agent-zcode",
  name: "Zcode（Terminal）",
  icon: "terminal",
  metadata: { customIcon: "https://cdn.example/zcode.png" },
};

function latestVersionBy(author: { authorAgentId?: string | null; authorUserId?: string | null }) {
  return {
    revisionNumber: 5,
    createdAt: "2026-08-27T08:21:05.884Z",
    authorUserId: author.authorUserId ?? null,
    authorAgentId: author.authorAgentId ?? null,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("TeamRules single-document policy", () => {
  let container: HTMLDivElement;

  async function renderTeamRules() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TeamRules />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function buttons() {
    return [...container.querySelectorAll("button")];
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("offers neither create nor delete once the document exists", async () => {
    mockApi.get.mockResolvedValue([NOTE]);
    const root = await renderTeamRules();

    expect(buttons().find((b) => b.textContent?.includes("创建规则文档"))).toBeUndefined();
    expect(container.querySelector('button[aria-label="删除"]')).toBeNull();
    // Maintaining the one document stays possible: edit is still offered.
    expect(container.querySelector('button[aria-label="编辑"]')).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("offers create only while the company has no document yet", async () => {
    mockApi.get.mockResolvedValue([]);
    const root = await renderTeamRules();

    expect(buttons().find((b) => b.textContent?.includes("创建规则文档"))).toBeDefined();

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the rules text length, since the document only grows", async () => {
    const body = "x".repeat(3680);
    mockApi.get.mockResolvedValue([{ ...NOTE, body }]);
    const root = await renderTeamRules();

    expect(container.textContent).toContain("3,680 字符");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders the meta line between the title and the rules body", async () => {
    mockApi.get.mockResolvedValue([NOTE]);
    const root = await renderTeamRules();

    const meta = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("更新于"));
    const bodyDiv = [...container.querySelectorAll("div")].find((d) => d.textContent === "# 团队通用规则");
    expect(meta).toBeDefined();
    expect(bodyDiv).toBeDefined();
    // The long body used to push the byline out of sight; it now precedes it.
    expect(meta!.compareDocumentPosition(bodyDiv!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    flushSync(() => {
      root.unmount();
    });
  });

  it("expands the version panel before the rules body, in a bounded scroll area", async () => {
    const version = {
      id: "v-2",
      noteId: "note-1",
      revisionNumber: 2,
      title: NOTE.title,
      body: NOTE.body,
      label: null,
      authorUserId: null,
      authorAgentId: "agent-zcode",
      createdAt: "2026-08-27T08:21:05.884Z",
    };
    mockAgentsApi.list.mockResolvedValue([AGENT]);
    mockApi.get.mockImplementation(async (path: string) => {
      if (path.includes("/versions")) return [version];
      return [NOTE];
    });
    const root = await renderTeamRules();

    const toggle = buttons().find((b) => b.getAttribute("aria-label") === "版本历史");
    expect(toggle).toBeDefined();
    flushSync(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const panel = [...container.querySelectorAll("div")].find((d) => d.textContent?.includes("1 个版本"));
    const bodyDiv = [...container.querySelectorAll("div")].find((d) => d.textContent === "# 团队通用规则");
    expect(panel).toBeDefined();
    // Readers no longer scroll past the whole document to reach the history.
    expect(panel!.compareDocumentPosition(bodyDiv!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The list stays bounded no matter how many revisions accumulate.
    expect(container.querySelector(".max-h-72.overflow-y-auto")).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the latest revision's author as updater, with the agent brand mark", async () => {
    mockAgentsApi.list.mockResolvedValue([AGENT]);
    mockApi.get.mockResolvedValue([{ ...NOTE, latestVersion: latestVersionBy({ authorAgentId: AGENT.id }) }]);
    const root = await renderTeamRules();

    const meta = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("更新于"));
    expect(meta?.textContent).toContain("Zcode（Terminal）");
    expect(meta?.textContent).toContain("创建于");
    expect(meta?.querySelector(`img[src="${AGENT.metadata.customIcon}"]`)).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("labels a human author as Board instead of an agent name", async () => {
    mockApi.get.mockResolvedValue([
      { ...NOTE, createdByUserId: "user-9", latestVersion: latestVersionBy({ authorUserId: "user-9" }) },
    ]);
    const root = await renderTeamRules();

    const meta = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("更新于"));
    expect(meta?.textContent).toContain("Board");

    flushSync(() => {
      root.unmount();
    });
  });
});
