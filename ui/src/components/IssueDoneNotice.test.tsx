// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { IssueDoneNotice } from "./IssueDoneNotice";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    listDocuments: vi.fn(async () => [
      { key: "requirements" },
      { key: "tech-proposal" },
      { key: "review-r1-codex" },
    ]),
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** retry: false 让失败的查询立刻结束，否则测试要等重试退避。 */
function renderWithClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("IssueDoneNotice", () => {
  it("renders the past-tense notice when the issue is done", () => {
    renderWithClient(<IssueDoneNotice issueStatus="done" />);

    expect(container.textContent).toContain("本 issue 为过去时");
    expect(container.textContent).toContain("一切以当前为准");
  });

  it("renders nothing while the issue is still open", () => {
    renderWithClient(<IssueDoneNotice issueStatus="in_progress" />);

    expect(container.textContent).toBe("");
  });

  it("lists the materials the closed card left behind", async () => {
    renderWithClient(<IssueDoneNotice issueStatus="done" issueId="issue-1" />);
    // 查询是异步的，轮询到那行出现为止，别用固定次数的 microtask 猜时序。
    for (let i = 0; i < 50 && !container.textContent?.includes("留下的材料"); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(container.textContent).toContain("留下的材料：需求底稿、技术方案");
    // 不是四样材料之一的文档不进索引，否则一张卡的评审轮次会把这行撑爆。
    expect(container.textContent).not.toContain("review-r1-codex");
  });
});
