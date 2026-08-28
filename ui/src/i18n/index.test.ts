// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { currentUiLanguage, setUiLanguage, t } from ".";

describe("ui language switching", () => {
  afterEach(() => {
    setUiLanguage("en");
    window.localStorage.clear();
  });

  it("defaults to English and falls back to the key for unknown entries", () => {
    expect(currentUiLanguage()).toBe("en");
    expect(t("New Task")).toBe("New Task");
    expect(t("totally.unknown")).toBe("totally.unknown");
  });

  it("switches to Simplified Chinese and translates known keys", () => {
    setUiLanguage("zh-CN");
    expect(currentUiLanguage()).toBe("zh-CN");
    expect(t("New Task")).toBe("新建任务");
    expect(t("Search tasks...")).toBe("搜索任务...");
    expect(t("{{count}} days", { count: 7 })).toBe("7 天");
    // Untranslated keys degrade to the English source text.
    expect(t("totally.unknown")).toBe("totally.unknown");
  });

  it("persists the choice in localStorage", () => {
    setUiLanguage("zh-CN");
    expect(window.localStorage.getItem("paperclip.ui.language")).toBe("zh-CN");
  });
});
