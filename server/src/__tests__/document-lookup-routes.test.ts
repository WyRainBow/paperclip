import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DOC_ID = "d5e387b2-a920-4633-a62a-cec6de592f9e";
const ISSUE_ID = "a869bb01-0e67-45e8-9e73-445bdaac834c";
const OTHER_ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockAccessDecide = vi.hoisted(() => vi.fn(async () => ({
  allowed: true,
  action: "issue:read",
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockLookupIssueDocumentsByIdOrPrefix = vi.hoisted(() => vi.fn(async () => [] as Array<Record<string, unknown>>));

const mockResolveTaskWatchdogMutationScope = vi.hoisted(() => vi.fn(async () => ({ kind: "none" })));
const mockResolveCoreTrustPreset = vi.hoisted(() => vi.fn(() => ({ kind: "standard" })));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/task-watchdog-scope.js", () => ({
  TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
  resolveTaskWatchdogMutationScope: mockResolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation: vi.fn(async (_db, scope) => scope),
}));

vi.mock("../services/trust-preset-resolver.js", () => ({
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH: 100,
  resolveCoreTrustPreset: mockResolveCoreTrustPreset,
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockAccessDecide,
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", companyId: "company-1", permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({
      lookupIssueDocumentsByIdOrPrefix: mockLookupIssueDocumentsByIdOrPrefix,
    }),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => ({}),
    issueThreadInteractionService: () => ({}),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      upsertForIssue: vi.fn(),
      disableForIssue: vi.fn(async () => null),
      revalidateMutationScope: vi.fn(async (scope: unknown) => ({ allowed: true, scope })),
    }),
    workProductService: () => ({}),
  }));
}

function lookupRow(overrides: Record<string, unknown> = {}) {
  return {
    documentId: DOC_ID,
    companyId: "company-1",
    key: "collection-timing-design",
    title: "采集点与采集时间设计",
    latestRevisionNumber: 1,
    createdByAgentId: "22222222-2222-4222-8222-222222222222",
    createdByUserId: null,
    updatedAt: "2026-08-29T16:23:16.760Z",
    issueId: ISSUE_ID,
    issueCompanyId: "company-1",
    issueProjectId: null,
    issueParentId: null,
    issueAssigneeAgentId: null,
    issueAssigneeUserId: null,
    issueIdentifier: "MUL-167",
    issueTitle: "经验复盘缺追溯链路",
    issueStatus: "in_review",
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as never, {} as never, {}));
  app.use(errorHandler);
  return app;
}

describe.sequential("document lookup routes (MUL-172)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockResolveTaskWatchdogMutationScope.mockResolvedValue({ kind: "none" });
    mockResolveCoreTrustPreset.mockReturnValue({ kind: "standard" });
    mockAccessDecide.mockReset();
    mockAccessDecide.mockResolvedValue({
      allowed: true,
      action: "issue:read",
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    });
    mockLookupIssueDocumentsByIdOrPrefix.mockReset();
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([]);
  });

  it("resolves an 8-char docID to the document and its owning issue", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([lookupRow()]);
    const app = await createApp();
    const res = await request(app).get("/api/documents/d5e387b2");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      query: "d5e387b2",
      matches: [
        {
          documentId: DOC_ID,
          key: "collection-timing-design",
          issue: { id: ISSUE_ID, identifier: "MUL-167", status: "in_review" },
        },
      ],
    });
    expect(mockLookupIssueDocumentsByIdOrPrefix).toHaveBeenCalledWith("d5e387b2", ["company-1"]);
  });

  it("normalizes a full dashed uuid before prefix matching", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([lookupRow()]);
    const app = await createApp();
    const res = await request(app).get(`/api/documents/${DOC_ID.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(mockLookupIssueDocumentsByIdOrPrefix).toHaveBeenCalledWith("d5e387b2a9204633a62acec6de592f9e", ["company-1"]);
  });

  it("returns all candidates on an ambiguous prefix instead of guessing", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([
      lookupRow(),
      lookupRow({
        documentId: "d5e387b2-0000-0000-0000-000000000002",
        key: "requirements",
        issueId: OTHER_ISSUE_ID,
        issueIdentifier: "MUL-172",
      }),
    ]);
    const app = await createApp();
    const res = await request(app).get("/api/documents/d5e387b2");
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(2);
    expect(new Set(res.body.matches.map((m: { issue: { identifier: string } }) => m.issue.identifier)))
      .toEqual(new Set(["MUL-167", "MUL-172"]));
  });

  it("rejects malformed idOrPrefix with 400", async () => {
    const app = await createApp();
    expect((await request(app).get("/api/documents/abc")).status).toBe(400);
    expect((await request(app).get("/api/documents/zzzzzzzz")).status).toBe(400);
    expect((await request(app).get("/api/documents/1234567")).status).toBe(400);
    expect(mockLookupIssueDocumentsByIdOrPrefix).not.toHaveBeenCalled();
  });

  it("404s when nothing matches", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([]);
    const app = await createApp();
    const res = await request(app).get("/api/documents/00000000");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Document not found");
  });

  it("scopes an agent actor to its own company only", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([]);
    const app = await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-2",
      runId: null,
    });
    const res = await request(app).get("/api/documents/d5e387b2");
    expect(res.status).toBe(404);
    expect(mockLookupIssueDocumentsByIdOrPrefix).toHaveBeenCalledWith("d5e387b2", ["company-2"]);
  });

  it("drops candidates outside the actor's issue-read boundary", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([
      lookupRow(),
      lookupRow({ issueId: OTHER_ISSUE_ID, issueIdentifier: "MUL-172" }),
    ]);
    mockAccessDecide.mockImplementation(async (input: { resource?: { issueId?: string } }) => ({
      allowed: input.resource?.issueId === OTHER_ISSUE_ID,
      action: "issue:read",
      reason: "deny_not_visible",
      explanation: "Denied by test.",
    }));
    const app = await createApp();
    const res = await request(app).get("/api/documents/d5e387b2");
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].issue.identifier).toBe("MUL-172");
  });

  it("404s when every candidate is outside the actor's boundary", async () => {
    mockLookupIssueDocumentsByIdOrPrefix.mockResolvedValue([lookupRow()]);
    mockAccessDecide.mockResolvedValue({
      allowed: false,
      action: "issue:read",
      reason: "deny_not_visible",
      explanation: "Denied by test.",
    });
    const app = await createApp();
    const res = await request(app).get("/api/documents/d5e387b2");
    expect(res.status).toBe(404);
  });

  it("403s an unauthenticated actor", async () => {
    const app = await createApp({ type: "none" });
    const res = await request(app).get("/api/documents/d5e387b2");
    expect(res.status).toBe(403);
    expect(mockLookupIssueDocumentsByIdOrPrefix).not.toHaveBeenCalled();
  });
});
