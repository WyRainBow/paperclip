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
};

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
});
