import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const COMPANY_ID = "b982ca51-95fb-4ba2-afa6-a3444d6c3c54";
const ISSUE_ID = "1f5cf9f6-1a02-4f22-9a2f-2a2a5d5a0001";
const AGENT_ID = "b3fba255-e89e-42d9-9fc9-5aec906bdc88";
const DECISION_ID = "6f2c1c0e-2d4b-4a5a-9d0f-0a0a5d5a0002";

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

function routedFetch() {
  return vi.fn().mockImplementation((url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/issues/MUL-67") {
      return Promise.resolve(jsonResponse({ id: ISSUE_ID, identifier: "MUL-67", companyId: COMPANY_ID }));
    }
    if (path === `/api/companies/${COMPANY_ID}/agents`) {
      return Promise.resolve(jsonResponse([{ id: AGENT_ID, name: "Claude（Terminal）", urlKey: "claude-terminal" }]));
    }
    if (path === `/api/companies/${COMPANY_ID}/decisions`) {
      return Promise.resolve(jsonResponse({ id: DECISION_ID, status: "open", originAgentId: AGENT_ID }, { status: 201 }));
    }
    if (path === `/api/decisions/${DECISION_ID}/decide`) {
      return Promise.resolve(jsonResponse({ id: DECISION_ID, status: "decided", chosenOptionId: "b", originAgentId: AGENT_ID }));
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  await program.parseAsync([
    "issue", "decision:create", ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("issue decision:create", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_AGENT_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // handleCommandError exits the process on failure; surface it as a throw so
    // a broken payload fails the test instead of killing the runner.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("builds the decision payload and settles it with --decided", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "MUL-67",
      "--title", "补录历史决策的通路",
      "--body", "## 背景\n终端只能裸 POST。",
      "--option", "a|维持现状",
      "--option", "b|放行 board 创建",
      "--decided", "b",
      "--rationale", "board 侧显式署名比借别人的 run 更可追",
      "--constraints", "外公司 agent 必须 422",
      "--created-by-agent", AGENT_ID,
    ]);

    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", new URL(String(call[0])).pathname]);
    expect(calls).toEqual([
      ["GET", "/api/issues/MUL-67"],
      ["GET", `/api/companies/${COMPANY_ID}/agents`],
      ["POST", `/api/companies/${COMPANY_ID}/decisions`],
      ["POST", `/api/decisions/${DECISION_ID}/decide`],
    ]);

    const createBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(createBody).toMatchObject({
      title: "补录历史决策的通路",
      originIssueId: ISSUE_ID,
      createdByAgentId: AGENT_ID,
    });
    expect(createBody.options).toHaveLength(2);
    // Effects are mandatory server-side, so the CLI fills each option with one
    // comment back on the originating card.
    expect(createBody.options[1]).toMatchObject({ id: "b", label: "放行 board 创建" });
    expect(createBody.options[1].effects[0]).toMatchObject({
      type: "comment_on_issue",
      targetIssueId: ISSUE_ID,
      staleness: "lenient",
    });

    const decideBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(decideBody).toEqual({
      optionId: "b",
      inputValues: { rationale: "board 侧显式署名比借别人的 run 更可追", constraints: "外公司 agent 必须 422" },
      actingAgentId: AGENT_ID,
    });
  });

  it("falls back to PAPERCLIP_AGENT_ID and leaves the decision open without --decided", async () => {
    process.env.PAPERCLIP_AGENT_ID = AGENT_ID;
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await run(["MUL-67", "--title", "T", "--body", "B", "--option", "a|只此一项"]);

    const calls = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(calls).not.toContain(`/api/decisions/${DECISION_ID}/decide`);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).createdByAgentId).toBe(AGENT_ID);
  });

  it("refuses a verdict with no rationale, before touching the create endpoint", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(run(["MUL-67", "--title", "T", "--body", "B", "--option", "a|A", "--decided", "a", "--created-by-agent", AGENT_ID]))
      .rejects.toThrow("process.exit(1)");
    expect(fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname))
      .not.toContain(`/api/companies/${COMPANY_ID}/decisions`);
  });

  it("refuses --decided naming an option that does not exist", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(run(["MUL-67", "--title", "T", "--body", "B", "--option", "a|A", "--decided", "zzz", "--rationale", "r", "--created-by-agent", AGENT_ID]))
      .rejects.toThrow("process.exit(1)");
  });

  it("refuses a malformed --option instead of shipping a half-built payload", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(run(["MUL-67", "--title", "T", "--body", "B", "--option", "no-pipe", "--created-by-agent", AGENT_ID]))
      .rejects.toThrow("process.exit(1)");
  });
});
