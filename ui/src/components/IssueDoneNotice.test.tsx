// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { IssueDoneNotice } from "./IssueDoneNotice";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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
    act(() => {
      root.render(<IssueDoneNotice issueStatus="done" />);
    });

    expect(container.textContent).toContain("本 issue 为过去时");
    expect(container.textContent).toContain("一切以当前为准");
  });

  it("renders nothing while the issue is still open", () => {
    act(() => {
      root.render(<IssueDoneNotice issueStatus="in_progress" />);
    });

    expect(container.textContent).toBe("");
  });
});
