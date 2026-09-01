import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { decisions, documents, issueDocuments } from "@paperclipai/db";

/**
 * The close-out prerequisite check (MUL-137, 老板令 2026-08-28).
 *
 * 一个 issue 必须起码有需求底稿、技术方案，以及决策依据。决策依据二选一
 * （MUL-465 放宽，老板令 2026-09-01）：decision-log 文档至少一条「已定」条目，
 * 或一张 decided 状态的关联决策卡——决策卡降级后，亲审场景只记 decision-log，
 * 不再强制开卡。That rule started as the MUL-37 convention (documents keyed
 * requirements / tech-proposal / spec plus a thin body); this check is the
 * enforcement half, consulted when a card tries to enter in_review or done.
 *
 * The decision linkage itself is already welded at the schema level
 * (`decisions.originIssueId` is a NOT NULL FK); here we additionally require
 * status "decided" so a draft decision no longer satisfies the gate by itself.
 *
 * Missing pieces are returned as lines that each name the fix, so the 422
 * tells the caller exactly what to put where instead of a bare "not allowed".
 */
/** 与 cli/src/commands/client/common.ts 的 DECISION_LOG_HEADING + isSettledDecisionLogEntry 同一判据（先判「已被」再判「已定」），两处需同步改。 */
function hasSettledDecisionLogEntry(body: string): boolean {
  for (const line of body.split("\n")) {
    const m = /^##\s+(\d+)\s+·\s+(\S+)\s+·\s+(.+)$/.exec(line);
    if (!m) continue;
    if (m[3].includes("已被")) continue;
    if (m[3].includes("已定")) return true;
  }
  return false;
}

export async function missingIssueClosePrerequisites(
  db: Pick<Db, "select">,
  companyId: string,
  issue: { id: string; description: string | null },
): Promise<string[]> {
  const missing: string[] = [];

  if (!(issue.description ?? "").trim()) {
    missing.push("正文（description）为空——issue update <卡> --description \"> 一句话摘要…\"，厚内容走文档");
  }

  const docRows = await db
    .select({ key: issueDocuments.key, body: documents.latestBody })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.issueId, issue.id),
      inArray(issueDocuments.key, ["requirements", "tech-proposal", "decision-log"]),
    ));
  const keys = new Set(docRows.map((row) => row.key));
  if (!keys.has("requirements")) {
    missing.push("缺「需求底稿」文档——issue document:put <卡> requirements --body-file 底稿.md");
  }
  if (!keys.has("tech-proposal")) {
    missing.push("缺「技术方案」文档——issue document:put <卡> tech-proposal --body-file 方案.md");
  }

  const decisionLogBody = docRows.find((row) => row.key === "decision-log")?.body ?? "";
  const [decision] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(
      eq(decisions.companyId, companyId),
      eq(decisions.originIssueId, issue.id),
      eq(decisions.status, "decided"),
    ))
    .limit(1);
  if (!decision && !hasSettledDecisionLogEntry(decisionLogBody)) {
    missing.push("缺决策依据（二选一即可）——decision-log 至少一条「已定」条目（issue document:put <卡> decision-log …），或 decided 决策卡（decision create --issue <卡> … 后 decide <id>）");
  }

  return missing;
}

/**
 * 门禁前置可发现 (MUL-448, 老板令 2026-08-31).
 *
 * The gates along 建卡→认领→开工→干活→收尾 all answer at write time: an agent
 * finishes a whole card, pushes in_review, and only then learns it is missing
 * three documents. The judgement above was already pure and read-only — this
 * is the read side of the same rules, so `issue claim` can print the card's
 * whole debt when it is taken rather than when it is closed.
 *
 * Deliberately NOT a guarantee. It covers the four gates whose conditions are
 * knowable from the card plus the caller's identity (收卡门禁 MUL-137,
 * 认领门禁 MUL-72, 裁决模式 MUL-131, 交接门禁 invalid_issue_disposition).
 * Revision conflicts and decision body validation stay write-time only because
 * their inputs do not exist until the write is attempted; `coverage` says so in
 * the payload so an empty `blocking` is never read as "nothing can stop me".
 *
 * The 交接门禁 verdict is computed by the caller rather than here: its five
 * accepted paths need the interaction and approval services, which live in the
 * route. Passing the boolean in keeps this module db-only and, more
 * importantly, keeps the write-time gate and this read the same judgement —
 * both call the route's hasInReviewReviewPath.
 */
export type IssuePreflightActor =
  | { type: "agent"; agentId: string | null }
  | { type: "board" }
  | { type: "other" };

export type IssuePreflightBlocker = {
  gate: string;
  code: string;
  detail: string[];
  fix: string;
};

export type IssuePreflight = {
  issueId: string;
  status: string | null;
  /** Every gate that would reject this caller's next write. */
  blocking: IssuePreflightBlocker[];
  closeGate: { ready: boolean; missing: string[] };
  claimGate: {
    claimed: boolean;
    assigneeAgentId: string | null;
    drivingAgentId: string | null;
    blocksThisActor: boolean;
  };
  adjudicationGate: { mode: string; canSelfClose: boolean };
  reviewPathGate: { ready: boolean; blocksThisActor: boolean };
  /**
   * 开工登记 (MUL-465)：not a gate — nothing rejects a card for missing it.
   * It rides along because "开工前把讨论提炼成决策卡" has no moment to fire
   * when `issue start` never ran, so the answer to "why is the card always
   * short a decision at close time" is usually here.
   */
  startGate: { started: boolean; workingBranch: string | null };
  coverage: string;
};

export async function issuePreflight(
  db: Pick<Db, "select">,
  issue: {
    id: string;
    companyId: string;
    description: string | null;
    status: string | null;
    assigneeAgentId: string | null;
    drivingAgentId: string | null;
    workingBranch?: string | null;
  },
  actor: IssuePreflightActor,
  adjudicationMode: string,
  /** Whether the card already hands the next action to someone — see the route's hasInReviewReviewPath. */
  hasReviewPath: boolean,
): Promise<IssuePreflight> {
  const missing = await missingIssueClosePrerequisites(db, issue.companyId, issue);
  const claimed = issue.assigneeAgentId != null || issue.drivingAgentId != null;
  // Both agent-only gates exempt board callers, so every answer here is about
  // this caller rather than about the card in the abstract.
  const isAgent = actor.type === "agent";
  const claimBlocks = isAgent && !claimed;
  const canSelfClose = !isAgent || adjudicationMode !== "manual";

  const blocking: IssuePreflightBlocker[] = [];
  if (claimBlocks) {
    blocking.push({
      gate: "认领门禁",
      code: "issue_unclaimed",
      detail: ["这张卡没有 assignee 也没有 Driving，你写进度或推状态会被 409 挡回"],
      fix: `paperclipai issue claim ${issue.id}`,
    });
  }
  if (missing.length > 0) {
    blocking.push({
      gate: "收卡门禁",
      code: "issue_prerequisites_missing",
      detail: missing,
      fix: "按每行末尾的命令逐样补齐，再推 in_review",
    });
  }
  if (!canSelfClose) {
    blocking.push({
      gate: "裁决模式",
      code: "manual_adjudication_required",
      detail: ["当前是亲审模式，收卡的裁决权在人，你自己置 done 会被 422 挡回"],
      fix: `paperclipai issue update ${issue.id} --assignee-user-id local-board --status in_review，然后等老板在收件箱 Approve`,
    });
  }
  // 交接门禁: an agent may not park a card in in_review with nobody owning the
  // next action. Already in_review cards are past it, so only a card still to
  // be pushed can be blocked by it.
  const reviewPathBlocks = isAgent && !hasReviewPath && issue.status !== "in_review";
  if (reviewPathBlocks) {
    blocking.push({
      gate: "交接门禁",
      code: "invalid_issue_disposition",
      detail: ["这张卡没有人也没有机制接下一步动作，推 in_review 会被 422 挡回"],
      fix: `认领它就行，接卡人算自己的验收人（MUL-451）：paperclipai issue claim ${issue.id}`,
    });
  }

  return {
    issueId: issue.id,
    status: issue.status,
    blocking,
    closeGate: { ready: missing.length === 0, missing },
    claimGate: {
      claimed,
      assigneeAgentId: issue.assigneeAgentId,
      drivingAgentId: issue.drivingAgentId,
      blocksThisActor: claimBlocks,
    },
    adjudicationGate: { mode: adjudicationMode, canSelfClose },
    reviewPathGate: { ready: hasReviewPath, blocksThisActor: reviewPathBlocks },
    startGate: { started: issue.workingBranch != null, workingBranch: issue.workingBranch ?? null },
    coverage:
      "只覆盖收卡门禁、认领门禁、裁决模式、交接门禁四道。开工登记不是门禁，只随报。文档修订冲突、正文防旧覆盖、决策三段校验等要到写入那一刻才判得出来，blocking 为空不等于一定写得进去。",
  };
}
