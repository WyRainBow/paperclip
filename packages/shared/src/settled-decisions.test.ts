import { describe, expect, it } from "vitest";
import { buildSettledDecisionsSnapshot, renderSettledDecisionsDocument } from "./settled-decisions.js";

function entry(number: number, status: string, sections: Array<[string, string]>): string {
  const lines = [`## ${number} · 2026-09-02 07:00 · ${status}`, ""];
  for (const [name, text] of sections) lines.push(`**${name}**`, "", text, "");
  return `${lines.join("\n")}---\n`;
}

const HEADER = "# decision-log · MUL-1\n\n> 用模板记录。\n\n---\n";

function full(number: number, q: string, a: string, status = "已定"): string {
  return entry(number, status, [
    ["问题", q],
    ["老板说", "原话"],
    ["我推荐（即本次裁决）", "推荐"],
    ["老板采纳", "采纳"],
    ["最终答案", a],
    ["落点", "落点"],
  ]);
}

function snapshotOf(body: string) {
  return buildSettledDecisionsSnapshot(body);
}

describe("buildSettledDecisionsSnapshot", () => {
  it("renders one row per settled entry when every entry is complete", () => {
    const body = HEADER + full(1, "问题一", "答案一") + full(2, "问题二", "答案二") + full(3, "问题三", "答案三");
    const snapshot = snapshotOf(body);
    expect(snapshot.total).toBe(3);
    expect(snapshot.settled).toBe(3);
    expect(snapshot.complete).toBe(3);
    expect(snapshot.gapEntryNumbers).toEqual([]);
    expect(snapshot.rows).toEqual([
      { index: 1, entryNumber: 1, question: "问题一", finalAnswer: "答案一" },
      { index: 2, entryNumber: 2, question: "问题二", finalAnswer: "答案二" },
      { index: 3, entryNumber: 3, question: "问题三", finalAnswer: "答案三" },
    ]);

    const doc = renderSettledDecisionsDocument({ issueId: "MUL-1", sourceRevisionId: "rev-9", snapshot });
    expect(doc).toContain("来源 decision-log revision：rev-9");
    expect(doc).toContain("流水账条目总数 N：3　当前已定 M：3　结构化完整 X/M：3/3");
    expect(doc).not.toContain("缺口条目");
    expect(doc.split("\n").filter((line) => line.startsWith("| 1 ")).length).toBe(1);
    expect(doc).toContain("| 3 | 问题三 | 答案三 | 第 3 条 |");
  });

  it("excludes overturned entries from M and from the table", () => {
    const body = HEADER + full(1, "问题一", "答案一", "已定（已被第 3 条推翻）") + full(2, "问题二", "答案二") + full(3, "问题三", "答案三");
    const snapshot = snapshotOf(body);
    expect(snapshot.total).toBe(3);
    expect(snapshot.settled).toBe(2);
    expect(snapshot.rows.map((r) => r.entryNumber)).toEqual([2, 3]);
    expect(snapshot.rows.map((r) => r.index)).toEqual([1, 2]);
    expect(renderSettledDecisionsDocument({ issueId: "MUL-1", sourceRevisionId: null, snapshot })).not.toContain("问题一");
  });

  it("degrades a missing section to a pointer instead of failing the batch", () => {
    const incomplete = entry(2, "已定", [
      ["问题", "问题二"],
      ["老板说", "原话"],
      ["我推荐", "推荐"],
      ["老板采纳", "采纳"],
      ["落点", "落点"],
    ]);
    const snapshot = snapshotOf(HEADER + full(1, "问题一", "答案一") + incomplete);
    expect(snapshot.settled).toBe(2);
    expect(snapshot.complete).toBe(1);
    expect(snapshot.gapEntryNumbers).toEqual([2]);
    expect(snapshot.rows[1]).toEqual({ index: 2, entryNumber: 2, question: "问题二", finalAnswer: null });

    const doc = renderSettledDecisionsDocument({ issueId: "MUL-1", sourceRevisionId: "rev-9", snapshot });
    expect(doc).toContain("| 2 | 问题二 | 未记录，见 decision-log 第 2 条 | 第 2 条 |");
    expect(doc).toContain("缺口条目：第 2 条");
    expect(doc).toContain("结构化完整 X/M：1/2");
  });

  it("flattens newlines and escapes pipes so the table survives", () => {
    const body =
      HEADER +
      entry(1, "已定", [
        ["问题", "第一行 a | b\n第二行"],
        ["老板说", "原话"],
        ["我推荐", "推荐"],
        ["老板采纳", "采纳"],
        ["最终答案", "答案里也有 | 竖线\n以及换行"],
        ["落点", "落点"],
      ]);
    const snapshot = snapshotOf(body);
    expect(snapshot.rows[0].question).toBe("第一行 a | b\n第二行");
    const doc = renderSettledDecisionsDocument({ issueId: "MUL-1", sourceRevisionId: "rev-9", snapshot });
    const row = doc.split("\n").find((line) => line.startsWith("| 1 "));
    expect(row).toBe("| 1 | 第一行 a \\| b 第二行 | 答案里也有 \\| 竖线 以及换行 | 第 1 条 |");
    expect(row!.replace(/\\\|/g, "").split("|").length).toBe(6);
  });

  it("reports an empty snapshot when nothing is settled", () => {
    const body = HEADER + full(1, "问题一", "答案一", "待定") + full(2, "问题二", "答案二", "已定（已被第 3 条推翻）");
    const snapshot = snapshotOf(body);
    expect(snapshot.total).toBe(2);
    expect(snapshot.settled).toBe(0);
    expect(snapshot.rows).toEqual([]);
  });

  it("reads a section written inline after a colon", () => {
    const body = [
      "## 1 · 2026-09-02 07:00 · 已定",
      "",
      "**问题**：冒号内联式写法算不算数",
      "**老板说**：原话",
      "**我推荐**：推荐",
      "**老板采纳**：采纳",
      "**最终答案**：算数",
      "**落点**：这里",
      "",
    ].join("\n");
    const snapshot = snapshotOf(body);
    expect(snapshot.rows[0]).toEqual({
      index: 1,
      entryNumber: 1,
      question: "冒号内联式写法算不算数",
      finalAnswer: "算数",
    });
  });

  it("keeps a section whose body opens with a bold sentence", () => {
    const body =
      HEADER +
      entry(1, "已定", [
        ["问题", "同步是单向还是双向"],
        ["老板说", "原话"],
        ["我推荐", "推荐"],
        ["老板采纳", "采纳"],
        ["最终答案", "**单向。** 后面还有正文，说明为什么单向。"],
        ["落点", "落点"],
      ]);
    const snapshot = snapshotOf(body);
    expect(snapshot.rows[0].finalAnswer).toBe("**单向。** 后面还有正文，说明为什么单向。");
    expect(snapshot.gapEntryNumbers).toEqual([]);
  });

  it("treats a section heading with a suffix as the next section", () => {
    const body = [
      HEADER,
      "## 1 · 2026-09-02 07:00 · 已定",
      "",
      "**问题**",
      "",
      "这一格的正文",
      "",
      "**老板说（原话照抄）**",
      "",
      "原话",
      "",
      "**我推荐（即本次裁决）**",
      "",
      "推荐",
      "",
      "**老板采纳**",
      "",
      "采纳",
      "",
      "**最终答案**",
      "",
      "答案",
      "",
      "**落点**",
      "",
      "落点",
      "",
      "---",
      "",
    ].join("\n");
    const snapshot = snapshotOf(body);
    expect(snapshot.rows[0].question).toBe("这一格的正文");
    expect(snapshot.rows[0].finalAnswer).toBe("答案");
  });

  it("does not truncate at a bold paragraph in the middle of a section", () => {
    const body =
      HEADER +
      entry(1, "已定", [
        ["问题", "问题一"],
        ["老板说", "原话"],
        ["我推荐", "推荐"],
        ["老板采纳", "采纳"],
        ["最终答案", "第一段。\n\n**第二段以加粗开头。** 还有下文。\n\n第三段。"],
        ["落点", "落点"],
      ]);
    const snapshot = snapshotOf(body);
    expect(snapshot.rows[0].finalAnswer).toBe("第一段。\n\n**第二段以加粗开头。** 还有下文。\n\n第三段。");
  });

  it("stops one section at the next one instead of swallowing it", () => {
    const body =
      HEADER +
      entry(1, "已定", [
        ["问题", "问题一"],
        ["老板说", "原话"],
        ["我推荐", "推荐"],
        ["老板采纳", "采纳"],
        ["最终答案", "**只有这句是答案。**"],
        ["落点", "落点内容不该被吃进来"],
      ]);
    const snapshot = snapshotOf(body);
    expect(snapshot.rows[0].finalAnswer).toBe("**只有这句是答案。**");
    expect(snapshot.rows[0].question).toBe("问题一");
  });
});
