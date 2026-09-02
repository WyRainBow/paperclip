import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";
import { buildSettledDecisionsSnapshot, renderSettledDecisionsDocument } from "@paperclipai/shared";

const REVISION_ID = "4a1f1a1e-0b6d-4f4e-9a1c-2d2a5d5a0003";

const DECISION_LOG = [
  "# decision-log · MUL-9",
  "",
  "---",
  "",
  "## 1 · 2026-09-02 07:00 · 已定",
  "",
  "**问题**：要不要生成快照",
  "**老板说**：要",
  "**我推荐**：要",
  "**老板采纳**：采纳",
  "**最终答案**：生成",
  "**落点**：CLI",
  "",
].join("\n");

const EXPECTED_BODY = renderSettledDecisionsDocument({
  issueId: "MUL-9",
  sourceRevisionId: REVISION_ID,
  snapshot: buildSettledDecisionsSnapshot(DECISION_LOG),
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

function routedFetch(options: { settledBody: string | null; putStatus?: number }) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/issues/MUL-9/documents/decision-log") {
      return Promise.resolve(jsonResponse({ body: DECISION_LOG, latestRevisionId: REVISION_ID }));
    }
    if (path === "/api/issues/MUL-9/documents/settled-decisions" && method === "GET") {
      if (options.settledBody === null) return Promise.resolve(jsonResponse({ message: "Not found" }, { status: 404 }));
      return Promise.resolve(jsonResponse({ body: options.settledBody, latestRevisionId: REVISION_ID }));
    }
    if (path === "/api/issues/MUL-9/documents/settled-decisions" && method === "PUT") {
      if (options.putStatus === 409) {
        return Promise.resolve(
          jsonResponse(
            { message: "Document was updated by someone else", details: { currentRevisionId: REVISION_ID } },
            { status: 409 },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ key: "settled-decisions", latestRevisionId: REVISION_ID }));
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  });
}

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  await program.parseAsync(
    ["issue", "decisions:snapshot", ...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

describe("issue decisions:snapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_AGENT_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("does not write when the rendered body is byte-identical to the current one", async () => {
    const fetchMock = routedFetch({ settledBody: EXPECTED_BODY });
    vi.stubGlobal("fetch", fetchMock);

    await run(["MUL-9"]);

    const methods = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", new URL(String(call[0])).pathname]);
    expect(methods).toEqual([
      ["GET", "/api/issues/MUL-9/documents/decision-log"],
      ["GET", "/api/issues/MUL-9/documents/settled-decisions"],
    ]);
  });

  it("writes with the current baseRevisionId when the body changed", async () => {
    const fetchMock = routedFetch({ settledBody: "# 旧的\n" });
    vi.stubGlobal("fetch", fetchMock);

    await run(["MUL-9"]);

    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put).toBeTruthy();
    const payload = JSON.parse(String(put?.[1]?.body));
    expect(payload.baseRevisionId).toBe(REVISION_ID);
    expect(payload.body).toBe(EXPECTED_BODY);
  });

  it("fails loudly on a concurrent-write conflict", async () => {
    const fetchMock = routedFetch({ settledBody: "# 旧的\n", putStatus: 409 });
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await expect(run(["MUL-9"])).rejects.toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain("并发冲突");
  });
});
