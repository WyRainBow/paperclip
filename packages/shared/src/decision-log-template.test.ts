import { describe, expect, it } from "vitest";
import { decisionLogTemplateError, missingDecisionLogSections } from "./decision-log-template.js";

const HEADER = "# decision-log · MUL-1\n\n> 用 v1 模板记录。\n\n---\n";

function entry(number: number, sections: string[], extra = ""): string {
  const lines = [`## ${number} · 2026-09-02 07:00 · 已定`, ""];
  for (const s of sections) lines.push(`**${s}**`, "", "内容", "");
  if (extra) lines.push(extra, "");
  return `${lines.join("\n")}---\n`;
}

const FULL = ["老板说", "我推荐", "老板采纳", "落点"];

describe("missingDecisionLogSections", () => {
  it("reports a newly added entry that is missing sections", () => {
    const prev = HEADER + entry(1, FULL);
    const next = prev + entry(2, ["老板说", "我推荐"]);
    expect(missingDecisionLogSections(prev, next)).toEqual([
      { number: 2, missing: ["老板采纳", "落点"] },
    ]);
  });

  it("lets an inherited bad entry through when this write did not touch it", () => {
    const prev = HEADER + entry(1, ["内容"]);
    const next = prev + entry(2, FULL);
    expect(missingDecisionLogSections(prev, next)).toEqual([]);
  });

  it("checks an inherited entry once its text changes", () => {
    const prev = HEADER + entry(1, ["内容"]);
    const next = HEADER + entry(1, ["内容"], "**推翻原因**");
    expect(missingDecisionLogSections(prev, next)).toEqual([
      { number: 1, missing: FULL },
    ]);
  });

  it("accepts a section name carrying a parenthesised suffix", () => {
    const next = HEADER + entry(1, ["老板说", "我推荐（即本次裁决）", "老板采纳", "落点"]);
    expect(missingDecisionLogSections("", next)).toEqual([]);
  });

  it("checks every entry when prevBody is empty", () => {
    const next = HEADER + entry(1, FULL) + entry(2, ["落点"]);
    expect(missingDecisionLogSections("", next)).toEqual([
      { number: 2, missing: ["老板说", "我推荐", "老板采纳"] },
    ]);
  });

  it("ignores a status-line-only edit that keeps the four sections", () => {
    const prev = HEADER + entry(1, FULL);
    const next = prev.replace("· 已定", "· 已被第 2 条推翻") + entry(2, FULL);
    expect(missingDecisionLogSections(prev, next)).toEqual([]);
  });
});

describe("decisionLogTemplateError", () => {
  it("returns null when nothing is missing", () => {
    expect(decisionLogTemplateError("", HEADER + entry(1, FULL))).toBeNull();
  });

  it("names the entry number, the missing sections and the placeholder wording", () => {
    const message = decisionLogTemplateError("", HEADER + entry(3, ["我推荐", "老板采纳"]));
    expect(message).toContain("第 3 条缺「老板说」「落点」");
    expect(message).toContain("老板说（原话照抄）/ 我推荐 / 老板采纳 / 落点");
    expect(message).toContain("本条老板未直接发话，由我主动记录");
  });
});
