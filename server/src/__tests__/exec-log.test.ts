import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { loadSelfReportedForIssues, parseExecLogDocument } from "../services/exec-log.js";

interface FakeDocRow {
  issueId: string;
  key: string;
  body: string | null;
  updatedAt: Date;
}

function fakeDb(rows: FakeDocRow[]): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db;
}

const VALID = [
  "# MUL-x 执行日志",
  "",
  "```exec-log",
  JSON.stringify({
    sessionId: "584904ba-3c3e-49a7-a57d-25efa28836c7",
    logPath: "~/.qoder/projects/slug/584904ba.jsonl",
    logRange: "2026-08-29T17:36Z..18:30Z",
    summary: "实现 qoder-local adapter 并合入 master",
    toolTotals: [
      { tool: "Bash", calls: 65, failed: 15 },
      { tool: "Read", calls: 40, failed: 0 },
    ],
    failureClusters: [
      { count: 2, subject: "issue start 401", cause: "无 run 终端 checkout 401" },
      { count: 4, subject: "写操作契约 4xx", cause: "CLI 参数猜错" },
    ],
    attribution: { cli: 7, env: 3, self: 3, preexisting: 1 },
    durationOutliers: [{ subject: "execute.probe.test.ts", ms: 54700, cause: "SessionStart hooks 主导" }],
  }),
  "```",
  "",
  "## 明细（可选）",
  "……",
].join("\n");

describe("parseExecLogDocument", () => {
  it("parses a well-formed exec-log block", () => {
    const parsed = parseExecLogDocument(VALID);
    expect(parsed?.parseError).toBeNull();
    expect(parsed?.header?.sessionId).toBe("584904ba-3c3e-49a7-a57d-25efa28836c7");
    expect(parsed?.header?.toolTotals).toEqual([
      { tool: "Bash", calls: 65, failed: 15 },
      { tool: "Read", calls: 40, failed: 0 },
    ]);
    expect(parsed?.header?.attribution).toEqual({ cli: 7, env: 3, self: 3, preexisting: 1 });
    expect(parsed?.header?.failureClusters).toHaveLength(2);
    expect(parsed?.header?.durationOutliers[0]?.ms).toBe(54700);
  });

  it("returns null for legacy free-form bodies without a block (degradation is counted by the key-matching aggregator)", () => {
    expect(parseExecLogDocument("# MUL-169 执行日志\n\n总量约 65 次……")).toBeNull();
  });

  it("reports invalid JSON inside the block", () => {
    const parsed = parseExecLogDocument("```exec-log\n{not json}\n```");
    expect(parsed?.header).toBeNull();
    expect(parsed?.parseError).toContain("not valid JSON");
  });

  it("reports missing required fields", () => {
    const parsed = parseExecLogDocument("```exec-log\n{\"sessionId\":\"abc\"}\n```");
    expect(parsed?.parseError).toContain("logPath");
    expect(parsed?.parseError).toContain("summary");
  });

  it("tolerates missing optional structures", () => {
    const parsed = parseExecLogDocument(
      "```exec-log\n" +
        JSON.stringify({ sessionId: "abc", logPath: "/tmp/x.jsonl", summary: "s" }) +
        "\n```",
    );
    expect(parsed?.header?.toolTotals).toEqual([]);
    expect(parsed?.header?.attribution).toEqual({ cli: 0, env: 0, self: 0, preexisting: 0 });
  });

  it("returns null for empty or non-exec-log bodies", () => {
    expect(parseExecLogDocument(null)).toBeNull();
    expect(parseExecLogDocument("")).toBeNull();
    expect(parseExecLogDocument("# 别的文档\n正文")).toBeNull();
  });
});

describe("loadSelfReportedForIssues", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  it("aggregates parsed documents and degrades key-matched ones without a block", async () => {
    const db = fakeDb([
      { issueId: "i1", key: "exec-log-a", body: VALID, updatedAt: now },
      { issueId: "i1", key: "execution-log", body: "# 旧格式无结构块", updatedAt: now },
      { issueId: "i2", key: "exec-log-b", body: null, updatedAt: now },
    ]);
    const result = await loadSelfReportedForIssues(db, "c1", ["i1", "i2"]);

    const i1 = result.get("i1");
    expect(i1?.documents).toBe(2);
    expect(i1?.parsed).toBe(1);
    expect(i1?.parseErrors).toBe(1);
    expect(i1?.totalCalls).toBe(105);
    expect(i1?.failedCalls).toBe(15);
    expect(i1?.failureRate).toBeCloseTo(0.143, 2);
    expect(i1?.clusters).toBe(6);
    expect(i1?.latestAt).toBe(now.toISOString());

    const i2 = result.get("i2");
    expect(i2?.documents).toBe(1);
    expect(i2?.parsed).toBe(0);
    expect(i2?.parseErrors).toBe(1);
    expect(i2?.totalCalls).toBe(0);
  });

  it("returns an empty map for no issues without touching the db", async () => {
    const db = fakeDb([]);
    const result = await loadSelfReportedForIssues(db, "c1", []);
    expect(result.size).toBe(0);
  });
});
