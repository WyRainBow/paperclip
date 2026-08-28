import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "914fa626-0000-4000-8000-000000000000";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerIssueCommands(program);
  return program;
}

async function run(extraArgs: string[]): Promise<void> {
  await createProgram().parseAsync(
    [
      "issue", "create",
      "--title", "Attribution test",
      "--description", "> one-line summary",
      "--project-id", PROJECT_ID,
      "--company-id", COMPANY_ID,
      "--allow-duplicate",
      ...extraArgs,
      "--api-base", "http://localhost:3100",
      "--api-key", "agent-token",
    ],
    { from: "user" },
  );
}

function routingFetch(routes: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const route = routes[`${method} ${url}`];
    if (route !== undefined) return Promise.resolve(jsonResponse(route));
    if (method === "GET") return Promise.resolve(jsonResponse(null, { status: 404 }));
    return Promise.resolve(jsonResponse({ ok: true }));
  });
}

function createdIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    identifier: "MUL-999",
    title: "Attribution test",
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    createdByAgentId: AGENT_ID,
    createdByUserId: null,
    ...overrides,
  };
}

describe("issue create attribution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to file without an agent identity and never touches the create endpoint", async () => {
    const fetchMock = routingFetch({
      "GET http://localhost:3100/api/agents/me": null,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(run([])).rejects.toThrowError(/process\.exit/);
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/agents/me"],
    ]);
  });

  it("files in one write with an agent identity — no backfill, no follow-up PATCH", async () => {
    const fetchMock = routingFetch({
      "GET http://localhost:3100/api/agents/me": { id: AGENT_ID, name: "Zcode（Terminal）" },
      "POST http://localhost:3100/api/companies/22222222-2222-4222-8222-222222222222/issues": createdIssue(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await run([]);
    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]] as const);
    expect(calls).toEqual([
      ["GET", "http://localhost:3100/api/agents/me"],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/issues`],
    ]);
  });

  it("--as-board skips the identity gate and files without any follow-up PATCH", async () => {
    const fetchMock = routingFetch({
      "POST http://localhost:3100/api/companies/22222222-2222-4222-8222-222222222222/issues": createdIssue({
        createdByAgentId: null,
        createdByUserId: "local-board",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["--as-board"]);
    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]] as const);
    expect(calls).toEqual([
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/issues`],
    ]);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
