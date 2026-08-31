import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  decisionEffectExecutions,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { decisionRoutes } from "../routes/decisions.js";
import { withIssueDeleteAllowed } from "../services/issue-delete-guard.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping embedded Postgres decision route tests on this host: ${support.reason ?? "unsupported environment"}`);
}

describePg("decision create routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let foreignAgentId: string;
  let issueId: string;
  let runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    foreignAgentId = randomUUID();
    issueId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Decision Routes", issuePrefix: `DR${companyId.slice(0, 4)}` },
      { id: otherCompanyId, name: "Other Co", issuePrefix: `OC${otherCompanyId.slice(0, 4)}` },
    ]);
    const agentRow = { name: "Terminal", role: "engineer", status: "active" as const, adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await db.insert(agents).values([
      { id: agentId, companyId, ...agentRow },
      { id: foreignAgentId, companyId: otherCompanyId, ...agentRow },
    ]);
    // drivingAgentId is what makes the card claimed: an agent opening a
    // decision on an unclaimed card is 409'd (认领门禁扩面, MUL-443), and every
    // test here except the gate's own is about something else.
    await db.insert(issues).values({ id: issueId, companyId, identifier: "DR-1", title: "Origin", status: "in_progress", priority: "medium", drivingAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
  });

  afterEach(async () => {
    await db.delete(decisionEffectExecutions);
    await db.delete(decisionTargetIssues);
    await db.delete(decisions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    // Issues are archive-only (MUL-109): the trigger refuses every DELETE, so
    // this teardown had been silently leaving rows behind and every rerun died
    // on `DR-1` already existing. The escape hatch the migration ships for
    // exactly this is scoped to one transaction; reuse it rather than
    // sprinkling unique identifiers through the fixtures.
    await db.transaction(async (tx) => {
      await withIssueDeleteAllowed(tx, async () => {
        await tx.delete(issues);
      });
    });
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
    testApp.use("/api", decisionRoutes(db, { wakeOriginAgent: async () => undefined }));
    testApp.use(errorHandler);
    return testApp;
  }

  const boardActor = () => ({ type: "board", source: "local_implicit", userId: "board-user", companyIds: [companyId], isInstanceAdmin: false });
  const agentActor = () => ({ type: "agent", source: "agent_key", companyId, agentId, keyId: null, keyScope: { kind: "standard" }, runId: null });

  const payload = (extra: Record<string, unknown> = {}) => ({
    title: "Backfill?",
    // 三段死模板 (MUL-86) needs each heading at the start of its own line;
    // this fixture used to be the single line "背景 / 判断标准 / 方案", which
    // passed before that gate landed and has 422'd every run since.
    body: ["## 背景", "记不记这一笔。", "## 判断标准", "看有没有人会回头查。", "## 方案", "**A · 记** 代价是多一条噪音。", "**B · 不记** 代价是查不到。"].join("\n"),
    originIssueId: issueId,
    // 推荐必填: exactly one option carries recommendedByAgentId plus a
    // non-empty reason. Another gate that landed after this fixture was written.
    options: [
      {
        id: "yes",
        label: "记下来",
        recommendedByAgentId: agentId,
        recommendationReason: "查得到比省一条噪音重要。",
        effects: [{ type: "comment_on_issue", targetIssueId: issueId, staleness: "lenient", bodyMarkdown: "采纳" }],
      },
      { id: "no", label: "不记", effects: [] },
    ],
    ...extra,
  });

  it("lets the board create a decision attributed to a named company agent", async () => {
    const created = await request(app(boardActor()))
      .post(`/api/companies/${companyId}/decisions`)
      .send(payload({ createdByAgentId: agentId }))
      .expect(201);
    expect(created.body).toMatchObject({ originAgentId: agentId, originIssueId: issueId, originRunId: null, status: "open" });

    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.created"));
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: agentId });
  });

  it("rejects a createdByAgentId from another company with 422", async () => {
    const response = await request(app(boardActor()))
      .post(`/api/companies/${companyId}/decisions`)
      .send(payload({ createdByAgentId: foreignAgentId }))
      .expect(422);
    expect(response.body.error).toBe("createdByAgentId does not belong to this company");
    expect(await db.select().from(decisions)).toHaveLength(0);
  });

  it("still refuses a board create with no agent named, and says how to name one", async () => {
    const response = await request(app(boardActor()))
      .post(`/api/companies/${companyId}/decisions`)
      .send(payload())
      .expect(403);
    expect(response.body.error).toContain("createdByAgentId");
  });

  it("keeps the agent-actor create path on its own identity", async () => {
    const created = await request(app(agentActor()))
      .post(`/api/companies/${companyId}/decisions`)
      .send(payload({ createdByAgentId: foreignAgentId }))
      .expect(201);
    // An agent may not launder a decision onto someone else: its own key wins
    // over whatever createdByAgentId the body carried.
    expect(created.body).toMatchObject({ originAgentId: agentId, originIssueId: issueId });
  });

  it("settles a board-created decision through decide with the same agent acting", async () => {
    const created = await request(app(boardActor()))
      .post(`/api/companies/${companyId}/decisions`)
      .send(payload({ createdByAgentId: agentId }))
      .expect(201);
    const decided = await request(app(boardActor()))
      .post(`/api/decisions/${created.body.id}/decide`)
      .send({ optionId: "yes", inputValues: { rationale: "补录一条已经拍过板的决策" }, actingAgentId: agentId })
      .expect(200);
    expect(decided.body).toMatchObject({ status: "decided", chosenOptionId: "yes", decidedByUserId: "board-user", decidedByAgentId: agentId });
    expect(decided.body.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
  });

  describe("认领门禁扩面 (MUL-443)", () => {
    /** Undo the fixture's claim so the card reads as nobody's. */
    const unclaim = async () => {
      await db.update(issues).set({ drivingAgentId: null, assigneeAgentId: null }).where(eq(issues.id, issueId));
    };

    it("409s an agent opening a decision on an unclaimed card", async () => {
      await unclaim();
      const response = await request(app(agentActor()))
        .post(`/api/companies/${companyId}/decisions`)
        .send(payload())
        .expect(409);
      expect(response.body.details).toMatchObject({ code: "issue_unclaimed", issueId, deliverable: "decision" });
      expect(response.body.error).toContain("issue claim");
      // Nothing was filed: a rejected create must not leave a half-decision.
      expect(await db.select().from(decisions)).toHaveLength(0);
    });

    it("lets the board open one on the same unclaimed card", async () => {
      await unclaim();
      await request(app(boardActor()))
        .post(`/api/companies/${companyId}/decisions`)
        .send(payload({ createdByAgentId: agentId }))
        .expect(201);
    });

    it("lets an agent through once the card carries Driving", async () => {
      await unclaim();
      await db.update(issues).set({ drivingAgentId: agentId }).where(eq(issues.id, issueId));
      await request(app(agentActor()))
        .post(`/api/companies/${companyId}/decisions`)
        .send(payload())
        .expect(201);
    });

    it("rejects a whole bundle when one item's origin card is unclaimed", async () => {
      await unclaim();
      const response = await request(app(agentActor()))
        .post(`/api/companies/${companyId}/decision-bundles`)
        .send({ title: "两条一起提", summary: "都挂在同一张未认领的卡上", decisions: [payload(), payload()] })
        .expect(409);
      expect(response.body.details).toMatchObject({ code: "issue_unclaimed", deliverable: "decision" });
      expect(await db.select().from(decisions)).toHaveLength(0);
    });
  });
});
