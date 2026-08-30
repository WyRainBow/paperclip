import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDocumentCommands } from "../commands/client/document.js";

const DOC_ID = "fbc222e5-7301-43ef-91ab-11ce0daa6104";

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

function lookupBody(matches: unknown[]) {
  return { query: "fbc222e5", matches };
}

function matchFixture(overrides: Record<string, unknown> = {}) {
  return {
    documentId: DOC_ID,
    companyId: "22222222-2222-4222-8222-222222222222",
    key: "tech-proposal",
    title: "技术方案",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "local-board",
    updatedAt: "2026-08-30T12:39:33.368Z",
    issue: {
      id: "a71a0e45-be91-40be-8670-bf3207fca0ad",
      identifier: "MUL-172",
      title: "docID 反查缺口",
      status: "in_review",
    },
    ...overrides,
  };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDocumentCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(["document", ...args, "--api-base", "http://localhost:3100", "--api-key", "agent-token"], { from: "user" });
}

describe("document lookup command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs /api/documents/:idOrPrefix and prints the owning issue", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(lookupBody([matchFixture()]))));
    vi.stubGlobal("fetch", fetchMock);

    await run(["lookup", "fbc222e5"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit | undefined];
    expect(String(url)).toContain("/api/documents/fbc222e5");
    expect(String(init?.method ?? "GET").toUpperCase()).toBe("GET");
    const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("MUL-172");
    expect(logged).toContain("tech-proposal");
    expect(logged).toContain("1 match");
  });

  it("prints every candidate on an ambiguous prefix", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(lookupBody([
        matchFixture(),
        matchFixture({
          documentId: "fbc222e5-0000-0000-0000-000000000002",
          key: "requirements",
          issue: { id: "b-2", identifier: "MUL-173", title: "执行日志", status: "in_progress" },
        }),
      ]))),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["lookup", "fbc222e5"]);

    const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("2 matches");
    expect(logged).toContain("MUL-172");
    expect(logged).toContain("MUL-173");
  });

  it("dumps raw JSON in --json mode", async () => {
    const body = lookupBody([matchFixture()]);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body)));
    vi.stubGlobal("fetch", fetchMock);

    await run(["lookup", "fbc222e5", "--json"]);

    const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(JSON.parse(logged)).toEqual(body);
  });
});
