// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdjudicationModePicker, resolveAdjudicationMode } from "./AdjudicationModePicker";

const mockApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockApi }));

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  mockApi.getGeneral.mockReset();
  mockApi.updateGeneral.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function render() {
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AdjudicationModePicker />
      </QueryClientProvider>,
    ),
  );
  // Let the settings query settle — the trigger renders the default until then.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("resolveAdjudicationMode", () => {
  it("treats absent settings as 委托 — manual is the explicit opt-in", () => {
    expect(resolveAdjudicationMode(undefined)).toBe("auto");
    expect(resolveAdjudicationMode({})).toBe("auto");
    expect(resolveAdjudicationMode({ adjudicationMode: "manual" })).toBe("manual");
  });
});

describe("AdjudicationModePicker", () => {
  it("shows 委托 while settings are loading and after an empty payload", async () => {
    mockApi.getGeneral.mockResolvedValue({});
    await render();

    const trigger = container.querySelector('[data-testid="adjudication-mode-trigger"]');
    expect(trigger?.textContent).toContain("委托");
  });

  it("shows 亲审 when the stored mode is manual", async () => {
    mockApi.getGeneral.mockResolvedValue({ adjudicationMode: "manual" });
    await render();

    const trigger = container.querySelector('[data-testid="adjudication-mode-trigger"]');
    expect(trigger?.textContent).toContain("亲审");
  });
});
