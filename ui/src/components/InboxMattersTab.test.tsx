// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxMattersTab } from "./InboxMattersTab";
import type { AttentionItem } from "@paperclipai/shared";

const decisionItem = {
  id: "item-1",
  sourceKind: "decision",
  subject: {
    kind: "decision",
    id: "decision-1",
    companyId: "company-1",
    title: "收件箱条目给具体信息：方案A还是A+B",
    identifier: null,
    status: "open",
    href: null,
    metadata: { infoLine: "推荐：方案A——效果立竿见影、风险小" },
  },
  relatedIssue: { id: "issue-1", identifier: "MUL-157", title: "收件箱条目给具体信息", companyId: "company-1", kind: "issue", href: null, status: "todo" },
  dedupKey: "decision:decision-1",
} as unknown as AttentionItem;

const askItem = {
  id: "item-2",
  sourceKind: "issue_thread_interaction",
  subject: {
    kind: "interaction",
    id: "interaction-1",
    companyId: "company-1",
    title: "Logo 管理形态",
    identifier: null,
    status: "pending",
    href: null,
    metadata: { issueId: "issue-1", infoLine: "预设按钮要支持上传自定义 logo 吗？（①支持上传 / ②仅内置预设）" },
  },
  relatedIssue: { id: "issue-1", identifier: "MUL-152", title: "Logo 统一", companyId: "company-1", kind: "issue", href: null, status: "in_progress" },
  dedupKey: "interaction:interaction-1",
} as unknown as AttentionItem;

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = JSON.stringify(queryKey);
    if (key.includes("agents")) return { data: [] };
    return { data: { items: [decisionItem, askItem] }, isLoading: false };
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("./DecisionResolver", () => ({
  DecisionResolver: () => <div data-testid="decision-resolver">resolver</div>,
}));
vi.mock("./AttentionInteractionResolver", () => ({
  AttentionInteractionResolver: () => <div data-testid="interaction-resolver">resolver</div>,
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
  act(() => root.render(<InboxMattersTab />));
  return root;
}

describe("InboxMattersTab", () => {
  it("shows the matter line on every row — the recommendation / the question, not just the title (MUL-157)", () => {
    const root = render();

    const infos = container.querySelectorAll('[data-testid="inbox-matter-info"]');
    expect(infos).toHaveLength(2);
    expect(infos[0]?.textContent).toContain("推荐：方案A");
    expect(infos[1]?.textContent).toContain("上传自定义 logo");

    act(() => root.unmount());
  });

  it("expands the in-place resolver on click", () => {
    const root = render();

    const expandButtons = container.querySelectorAll('[data-testid="inbox-matter-expand"]');
    expect(expandButtons).toHaveLength(2);
    act(() => expandButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[data-testid="decision-resolver"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("shows the related issue identifier beside the kind badge", () => {
    const root = render();

    const text = container.textContent ?? "";
    expect(text).toContain("MUL-157");
    expect(text).toContain("MUL-152");

    act(() => root.unmount());
  });
});
