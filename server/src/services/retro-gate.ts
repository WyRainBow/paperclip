import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documents,
  feedbackVotes,
  issueComments,
  issueDocuments,
  issueLabels,
  issueRecoveryActions,
  issueWatchdogs,
  issues,
  labels,
  teamRuleNotes,
  teamRuleNoteVersions,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { documentService } from "./documents.js";
import { logger } from "../middleware/logger.js";

/**
 * The close-out gate (MUL-133 件三, decision 61891ec2).
 *
 * When a card reaches `in_review` or `done`, compute one friction score for
 * the whole card from facts the server itself wrote — status rollbacks,
 * blocked entries, extra review rounds, recovery actions, down votes,
 * watchdog triggers. teamai-cli computes friction from the terminal
 * transcript and documents four ways that signal goes stale (word lists,
 * 50MB ceilings, skipped declarations, self-calibrated thresholds); every
 * signal here is a row this server already wrote, so it cannot rot when an
 * upstream log format changes and it cannot be forged by the agent it
 * measures.
 *
 * First version records, it does not gate: every transition writes an
 * `issue.friction_scored` activity row so real score distributions can be
 * sampled before anyone picks a threshold (the MUL-59 precedent: observe
 * first, mechanize later). Crossing the provisional threshold only tags the
 * card `retro-owed` and files one progress note naming the signals — no
 * automatic case writing, the retro skill and the human decide the rest.
 */

/** One answerable failure fact: who, when, where in the flow, what code/reason. */
export interface FrictionEvidence {
  actor: string;
  at: string;
  stage: string;
  code: string;
  note?: string;
}

export interface FrictionSignal {
  key: "rollback" | "blocked" | "review_rounds" | "recovery" | "down_votes" | "watchdog";
  count: number;
  points: number;
  evidence?: Array<FrictionEvidence>;
}

export interface FrictionScore {
  total: number;
  signals: Array<FrictionSignal>;
}

/** Weights carry teamai-cli's order of magnitude, not Paperclip's calibration. */
export const FRICTION_WEIGHTS = {
  /** in_review→in_progress, or a done card reopened. */
  rollback: 20,
  /** Each entry into blocked counts once; the exit is the same episode. */
  blocked: 15,
  /** A review-r2-or-later document exists on the card. Flat, not per round. */
  review_rounds: 15,
  /** At least one recovery action was opened for this card. Flat. */
  recovery: 20,
  perDownVote: 20,
  /** The watchdog fired at least once. Flat. */
  watchdog: 10,
} as const;

/**
 * One strong signal is enough to owe a retro. Provisional on purpose — the
 * scored activity rows are what calibrate the real threshold.
 */
export const RETRO_OWED_SCORE_THRESHOLD = 20;

export const RETRO_OWED_LABEL = "retro-owed";

interface StatusTransitionRow {
  actorType: string;
  actorId: string | null;
  agentId: string | null;
  at: string;
  from: string;
  to: string;
  note?: string;
}

function actorLabel(actorType: string, actorId: string | null, agentId: string | null): string {
  if (actorType === "agent") return agentId ? `agent:${agentId}` : "agent";
  if (actorType === "user") return actorId ? `user:${actorId}` : "user";
  return actorType;
}

/**
 * Fetch `issue.updated` activity rows whose details describe a given status
 * transition, keeping actor and timing so each friction signal can answer
 * "who failed, when, moving what to what" (MUL-167). The update path logs
 * `details.status` (new), `details._previous.status` (old), and — for rows
 * written since MUL-167 — `details.commentExcerpt` when the transition came
 * with a comment. Pass `"*"` for either side to leave it unconstrained.
 */
async function fetchStatusTransitions(
  db: Db,
  issueId: string,
  from: string | "*",
  to: string | "*",
): Promise<StatusTransitionRow[]> {
  const rows = await db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      agentId: activityLog.agentId,
      createdAt: activityLog.createdAt,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.updated"),
      to === "*"
        ? sql`${activityLog.details}->>'status' is not null`
        : sql`${activityLog.details}->>'status' = ${to}`,
      from === "*"
        ? sql`true`
        : sql`coalesce(${activityLog.details}->'_previous'->>'status', '') = ${from}`,
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(10);
  return rows.map((row) => {
    const details = (row.details ?? {}) as Record<string, unknown>;
    const note = typeof details.commentExcerpt === "string" && details.commentExcerpt.trim()
      ? details.commentExcerpt.trim()
      : undefined;
    return {
      actorType: row.actorType,
      actorId: row.actorId,
      agentId: row.agentId,
      at: row.createdAt.toISOString(),
      from: String((details as { _previous?: { status?: unknown } })._previous?.status ?? "?"),
      to: String(details.status ?? "?"),
      note,
    };
  });
}

function transitionEvidence(rows: Array<StatusTransitionRow>): Array<FrictionEvidence> {
  return rows.slice(0, 5).map((row) => ({
    actor: actorLabel(row.actorType, row.actorId, row.agentId),
    at: row.at,
    stage: "status_transition",
    code: `${row.from}→${row.to}`,
    ...(row.note ? { note: row.note } : {}),
  }));
}

const EVIDENCE_CAP = 5;

export async function computeFrictionScore(db: Db, companyId: string, issueId: string): Promise<FrictionScore> {
  const [
    reviewRollbackRows,
    blockedRows,
    reviewRoundDocRows,
    recoveryRows,
    downVoteRows,
    watchdogRows,
    reopenRows,
  ] = await Promise.all([
    fetchStatusTransitions(db, issueId, "in_review", "in_progress"),
    fetchStatusTransitions(db, issueId, "*", "blocked"),
    db
      .select({ key: issueDocuments.key, updatedAt: documents.updatedAt })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.issueId, issueId),
        sql`${issueDocuments.key} ~ '^review-r([2-9]|[1-9][0-9]+)$'`,
      ))
      .orderBy(desc(documents.updatedAt))
      .limit(EVIDENCE_CAP),
    db
      .select({ createdAt: issueRecoveryActions.createdAt })
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ))
      .orderBy(desc(issueRecoveryActions.createdAt))
      .limit(EVIDENCE_CAP),
    db
      .select({ reason: feedbackVotes.reason, authorUserId: feedbackVotes.authorUserId, createdAt: feedbackVotes.createdAt })
      .from(feedbackVotes)
      .where(and(
        eq(feedbackVotes.companyId, companyId),
        eq(feedbackVotes.issueId, issueId),
        eq(feedbackVotes.vote, "down"),
      ))
      .orderBy(desc(feedbackVotes.createdAt))
      .limit(EVIDENCE_CAP),
    db
      .select({ triggerCount: issueWatchdogs.triggerCount, lastTriggeredAt: issueWatchdogs.lastTriggeredAt, watchdogAgentId: issueWatchdogs.watchdogAgentId })
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.issueId, issueId),
      ))
      .then((rows) => rows[0] ?? null),
    // Done reopens: previous status was `done`, destination varies.
    fetchStatusTransitionsDoneReopens(db, issueId),
  ]);

  const rollbackCount = reviewRollbackRows.length + reopenRows.length;
  const watchdogTriggered = (watchdogRows?.triggerCount ?? 0) > 0;

  const signals: Array<FrictionSignal> = [];
  if (rollbackCount > 0) {
    signals.push({
      key: "rollback",
      count: rollbackCount,
      points: rollbackCount * FRICTION_WEIGHTS.rollback,
      evidence: transitionEvidence([...reviewRollbackRows, ...reopenRows]),
    });
  }
  if (blockedRows.length > 0) {
    signals.push({
      key: "blocked",
      count: blockedRows.length,
      points: blockedRows.length * FRICTION_WEIGHTS.blocked,
      evidence: transitionEvidence(blockedRows),
    });
  }
  if (reviewRoundDocRows.length > 0) {
    signals.push({
      key: "review_rounds",
      count: reviewRoundDocRows.length,
      points: FRICTION_WEIGHTS.review_rounds,
      evidence: reviewRoundDocRows.map((row) => ({
        actor: "system",
        at: row.updatedAt.toISOString(),
        stage: "review_round",
        code: row.key,
      })),
    });
  }
  if (recoveryRows.length > 0) {
    signals.push({
      key: "recovery",
      count: recoveryRows.length,
      points: FRICTION_WEIGHTS.recovery,
      evidence: recoveryRows.map((row) => ({
        actor: "system",
        at: row.createdAt.toISOString(),
        stage: "recovery",
        code: "recovery_action",
      })),
    });
  }
  if (downVoteRows.length > 0) {
    signals.push({
      key: "down_votes",
      count: downVoteRows.length,
      points: downVoteRows.length * FRICTION_WEIGHTS.perDownVote,
      evidence: downVoteRows.map((row) => ({
        actor: `user:${row.authorUserId}`,
        at: row.createdAt.toISOString(),
        stage: "feedback",
        code: "down_vote",
        ...(row.reason?.trim() ? { note: row.reason.trim().slice(0, 140) } : {}),
      })),
    });
  }
  if (watchdogTriggered) {
    signals.push({
      key: "watchdog",
      count: 1,
      points: FRICTION_WEIGHTS.watchdog,
      evidence: [{
        actor: `agent:${watchdogRows!.watchdogAgentId}`,
        at: (watchdogRows!.lastTriggeredAt ?? new Date(0)).toISOString(),
        stage: "watchdog",
        code: `trigger×${watchdogRows!.triggerCount}`,
      }],
    });
  }

  return {
    total: signals.reduce((sum, signal) => sum + signal.points, 0),
    signals,
  };
}

async function fetchStatusTransitionsDoneReopens(db: Db, issueId: string): Promise<StatusTransitionRow[]> {
  const rows = await db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      agentId: activityLog.agentId,
      createdAt: activityLog.createdAt,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.updated"),
      sql`${activityLog.details}->'_previous'->>'status' = 'done'`,
      sql`coalesce(${activityLog.details}->>'status', '') <> 'done'`,
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(10);
  return rows.map((row) => {
    const details = (row.details ?? {}) as Record<string, unknown>;
    const note = typeof details.commentExcerpt === "string" && details.commentExcerpt.trim()
      ? details.commentExcerpt.trim()
      : undefined;
    return {
      actorType: row.actorType,
      actorId: row.actorId,
      agentId: row.agentId,
      at: row.createdAt.toISOString(),
      from: "done",
      to: String(details.status ?? "?"),
      note,
    };
  });
}

const SIGNAL_LABELS: Record<FrictionSignal["key"], string> = {
  rollback: "被打回重做过",
  blocked: "卡在 blocked 等过",
  review_rounds: "评审打到了第二轮以后",
  recovery: "动用过 recovery 换手",
  down_votes: "收到差评",
  watchdog: "watchdog 报过警",
};

/**
 * Down-vote reasons on this card, in plain words — the concrete "what went
 * wrong" half of the question the gate asks. Asset-version votes carry the
 * asset title so the boss sees WHICH rule misled the work, not just a uuid.
 */
async function downVoteReasonLines(db: Db, companyId: string, issueId: string): Promise<string[]> {
  const votes = await db
    .select({
      reason: feedbackVotes.reason,
      targetType: feedbackVotes.targetType,
      targetId: feedbackVotes.targetId,
    })
    .from(feedbackVotes)
    .where(and(
      eq(feedbackVotes.companyId, companyId),
      eq(feedbackVotes.issueId, issueId),
      eq(feedbackVotes.vote, "down"),
    ))
    .orderBy(desc(feedbackVotes.createdAt))
    .limit(3);

  const lines: string[] = [];
  for (const vote of votes) {
    const reason = vote.reason?.trim() || "（没写理由）";
    if (vote.targetType === "team_rule_note_version") {
      const [row] = await db
        .select({ title: teamRuleNotes.title })
        .from(teamRuleNoteVersions)
        .innerJoin(teamRuleNotes, eq(teamRuleNoteVersions.noteId, teamRuleNotes.id))
        .where(eq(teamRuleNoteVersions.id, vote.targetId))
        .limit(1);
      lines.push(row ? `规则「${row.title}」被投差评：${reason}` : `一条规则被投差评：${reason}`);
    } else if (vote.targetType === "team_wiki_page_version") {
      lines.push(`一页团队 Wiki 被投差评：${reason}`);
    } else if (vote.targetType === "company_skill_version") {
      lines.push(`一个团队 Skill 被投差评：${reason}`);
    } else {
      lines.push(`差评：${reason}`);
    }
  }
  return lines;
}

async function ensureRetroOwedLabel(db: Db, companyId: string): Promise<string> {
  const existing = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), eq(labels.name, RETRO_OWED_LABEL)))
    .then((rows) => rows[0] ?? null);
  if (existing) return existing.id;
  const [created] = await db
    .insert(labels)
    .values({ companyId, name: RETRO_OWED_LABEL, color: "#b45309" })
    .onConflictDoNothing()
    .returning({ id: labels.id });
  if (created) return created.id;
  const [row] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), eq(labels.name, RETRO_OWED_LABEL)))
    .limit(1);
  return row.id;
}

export interface RetroGateInput {
  companyId: string;
  issueId: string;
  identifier: string | null;
  /** `in_review` or `done` — recorded on the activity row for sampling. */
  enteredStatus: string;
  /** For the branch-registration reminder (MUL-144): null means no `issue start` ever ran. */
  workingBranch: string | null;
}

/**
 * MUL-163: draft the experience-draft for the boss directly from the
 * friction evidence, instead of waiting for a "记" reply to wake an agent.
 * The MUL-141 inbox reminder picks the draft up automatically once it
 * exists. Idempotent on purpose: a card that already sedimented (an
 * experience_remembered row names it) or already carries a draft is never
 * drafted twice (MUL-158's no-duplicate rule).
 */
async function autoDraftExperience(
  db: Db,
  input: RetroGateInput,
  score: FrictionScore,
): Promise<boolean> {
  const remembered = await db
    .select({ entityId: activityLog.entityId })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.action, "workspace.experience_remembered"),
      sql`${activityLog.details}->>'issueId' = ${input.issueId}`,
    ))
    .limit(1)
    .then((rows) => rows.length > 0);
  if (remembered) return false;

  const existingDraft = await db
    .select({ documentId: issueDocuments.documentId })
    .from(issueDocuments)
    .where(and(
      eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
      eq(issueDocuments.key, "experience-draft"),
    ))
    .limit(1)
    .then((rows) => rows.length > 0);
  if (existingDraft) return false;

  const evidenceLines: string[] = [];
  for (const signal of score.signals) {
    for (const ev of signal.evidence ?? []) {
      const note = ev.note ? `——${ev.note}` : "";
      evidenceLines.push(`- ${SIGNAL_LABELS[signal.key]}：${ev.actor} · ${ev.code} · ${ev.at.slice(0, 19).replace("T", " ")}${note}`);
    }
  }
  const body = [
    "# 经验草稿（自动起草 v1）",
    "",
    "> MUL-163 自动起草，素材来自卡上摩擦证据。老板批后由执行方跑 `workspace remember` 晋升 cases/；要改就直接改本页。",
    "",
    "## Situation（什么情况适用）",
    `- 卡 ${input.identifier ?? input.issueId.slice(0, 8)} 收尾摩擦分 ${score.total}（阈 ${RETRO_OWED_SCORE_THRESHOLD}）：${score.signals.map((s) => `${SIGNAL_LABELS[s.key]}×${s.count}`).join("、")}`,
    "",
    "## Approach（该怎么做）",
    "- （自动起草 v1 留白：执行方按下方证据补「下次遇到这种情况怎么做」）",
    "",
    "## Reflect（别踩什么）",
    ...(evidenceLines.length > 0 ? evidenceLines : ["- （本卡证据无 note，翻卡上 friction_scored 记录补）"]),
    "",
    "---",
    `- 来源：卡 ${input.identifier ?? input.issueId}；证据快照在卡上 friction_scored 活动记录`,
  ].join("\n");

  await documentService(db).upsertIssueDocument({
    issueId: input.issueId,
    key: "experience-draft",
    title: "经验草稿（自动起草）",
    format: "markdown",
    body,
  });
  return true;
}

export async function recordRetroGate(db: Db, input: RetroGateInput): Promise<FrictionScore | null> {
  try {
    const score = await computeFrictionScore(db, input.companyId, input.issueId);

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "retro-gate",
      action: "issue.friction_scored",
      entityType: "issue",
      entityId: input.issueId,
      issueId: input.issueId,
      details: {
        identifier: input.identifier,
        enteredStatus: input.enteredStatus,
        total: score.total,
        signals: score.signals,
        threshold: RETRO_OWED_SCORE_THRESHOLD,
        branchRegistered: Boolean(input.workingBranch?.trim()),
      },
    });

    if (score.total < RETRO_OWED_SCORE_THRESHOLD) return score;

    const labelId = await ensureRetroOwedLabel(db, input.companyId);
    await db
      .insert(issueLabels)
      .values({ companyId: input.companyId, issueId: input.issueId, labelId })
      .onConflictDoNothing();

    const problems: string[] = score.signals
      .filter((signal) => signal.key !== "down_votes")
      .map((signal) => `${SIGNAL_LABELS[signal.key]} ×${signal.count}`);
    problems.push(...await downVoteReasonLines(db, input.companyId, input.issueId));

    const drafted = await autoDraftExperience(db, input, score).catch((err) => {
      logger.warn({ err, issueId: input.issueId }, "auto experience draft failed (gate continues)");
      return false;
    });

    // Who worked this card — the question names them so the "记" reply has a
    // standing addressee. The agent is woken by the boss's reply (comment
    // wakeup on its card) and drafts from the facts already on the card.
    const worked = await db
      .select({ name: agents.name })
      .from(issues)
      .innerJoin(agents, eq(
        issues.assigneeAgentId ?? issues.drivingAgentId,
        agents.id,
      ))
      .where(eq(issues.id, input.issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    const standbyLine = worked
      ? `@${worked.name} 待命：老板回「记」≠直接落库——先把三段草稿写成卡上文档（键 experience-draft，素材用卡上的事实和差评理由），@老板过目；老板回「批」才跑 \`workspace remember\` 落 cases/ 并贴回链接，回的是修改意见就改完再等批。`
      : "回「记」后由执行 Agent 先出 experience-draft 草稿贴卡等批，老板批了才落 cases/。";

    const questionBlock = drafted
      ? [
          "**已自动起草经验草稿**（卡上文档 experience-draft，素材来自摩擦证据；收件箱有待批提醒）：",
          "- 你回「**批**」：执行方跑 `workspace remember` 正式落团队 Wiki 的 cases/，下次干活就能被搜到",
          "- 要改就直接改草稿页，或回要说改哪句",
          "- 回「**跳过**」：不沉淀，直接收卡",
        ]
      : [
          "**要不要把这次的教训记成一条经验 wiki？**（草稿制：先出草稿你过目，批了才入库）",
          "- 回「**记**」：Agent 起草三段（什么情况适用 / 该怎么做 / 别踩什么）贴到卡上等你过目",
          "- 你回「**批**」：才正式写进团队 Wiki 的 cases/，下次干活就能被搜到；要改就直接说改哪句",
          "- 回「**跳过**」：不记，直接收卡",
          "",
          standbyLine,
        ];

    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      body: [
        `这张卡走得磕绊（摩擦分 ${score.total}，阈 ${RETRO_OWED_SCORE_THRESHOLD}），这次遇到的问题是：`,
        ...problems.map((line) => `- ${line}`),
        "",
        ...questionBlock,
        "",
        "（分数只说明走得磕绊，不说明一定值得沉淀——决定权在你。卡已打 `retro-owed` 标签备查。）",
      ].join("\n"),
      presentation: { kind: "progress_note", tone: "info", detailsDefaultOpen: false },
      metadata: {
        version: 1,
        sections: [
          {
            title: "retro-gate",
            rows: [
              { type: "key_value", label: "frictionScore", value: String(score.total) },
              { type: "key_value", label: "threshold", value: String(RETRO_OWED_SCORE_THRESHOLD) },
            ],
          },
        ],
      },
    });
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));

    return score;
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "retro gate scoring failed (transition unaffected)");
    return null;
  }
}

export interface ExperienceBoardRow {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  frictionTotal: number;
  frictionSignals: Array<{ key: string; count: number; points: number }>;
  retroOwed: boolean;
  sediment: { path: string; at: string } | null;
  lastScoredAt: string | null;
  updatedAt: string;
}

/**
 * The experience board (MUL-133 需求三): one row per card that has ever been
 * friction-scored or sedimented — the boss's "which tasks deserve a second
 * look" surface. OV's tasks board answered the same question for its async
 * queues with status chips + per-row badges; this is that shape over our
 * card facts.
 */
export async function experienceBoardRows(db: Db, companyId: string): Promise<ExperienceBoardRow[]> {
  const [frictionRows, sedimentRows, retroOwedRows] = await Promise.all([
    db
      .select({
        entityId: activityLog.entityId,
        total: sql<number>`(${activityLog.details}->>'total')::int`,
        signals: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.friction_scored"),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(500),
    db
      .select({
        issueId: sql<string|null>`${activityLog.details}->>'issueId'`,
        path: sql<string|null>`${activityLog.details}->>'path'`,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "workspace.experience_remembered"),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(500),
    db
      .select({ issueId: issueLabels.issueId })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(and(eq(issueLabels.companyId, companyId), eq(labels.name, RETRO_OWED_LABEL))),
  ]);

  // Latest-per-issue (rows are desc by createdAt; first write wins).
  const frictionByIssue = new Map<string, { total: number; signals: Array<{ key: string; count: number; points: number }>; at: string }>();
  for (const row of frictionRows) {
    if (frictionByIssue.has(row.entityId)) continue;
    const rawSignals = Array.isArray((row.signals as Record<string, unknown> | null)?.signals)
      ? ((row.signals as Record<string, unknown>).signals as Array<{ key: string; count: number; points: number }>)
      : [];
    frictionByIssue.set(row.entityId, { total: Number(row.total ?? 0), signals: rawSignals, at: row.createdAt.toISOString() });
  }
  const sedimentByIssue = new Map<string, { path: string; at: string }>();
  for (const row of sedimentRows) {
    if (!row.issueId || sedimentByIssue.has(row.issueId) || !row.path) continue;
    sedimentByIssue.set(row.issueId, { path: row.path, at: row.createdAt.toISOString() });
  }
  const retroOwed = new Set(retroOwedRows.map((row) => row.issueId));

  const issueIds = [...new Set([...frictionByIssue.keys(), ...sedimentByIssue.keys(), ...retroOwed])];
  if (issueIds.length === 0) return [];
  const issueRows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, updatedAt: issues.updatedAt })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

  const rows: ExperienceBoardRow[] = issueRows.map((issue) => ({
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    frictionTotal: frictionByIssue.get(issue.id)?.total ?? 0,
    frictionSignals: frictionByIssue.get(issue.id)?.signals ?? [],
    retroOwed: retroOwed.has(issue.id),
    sediment: sedimentByIssue.get(issue.id) ?? null,
    lastScoredAt: frictionByIssue.get(issue.id)?.at ?? null,
    updatedAt: issue.updatedAt.toISOString(),
  }));
  rows.sort((a, b) => b.frictionTotal - a.frictionTotal || (a.sediment ? 0 : 1) - (b.sediment ? 0 : 1));
  return rows;
}

/**
 * The branch-registration reminder (MUL-144): claiming records ownership but
 * the working branch / worktree / session五件 only land via `issue start`,
 * and nothing between claim and close enforces them — cards were empirically
 * closed with branch=None. This is deliberately a soft note, not a gate:
 * research/discussion cards legitimately have no branch. Deduplicated by
 * exact body so repeated close transitions do not stack reminders.
 */
export async function noteUnregisteredBranch(
  db: Db,
  input: { companyId: string; issueId: string; identifier: string | null; workingBranch: string | null },
): Promise<void> {
  try {
    if (input.workingBranch?.trim()) return;
    const identifierText = input.identifier ?? input.issueId.slice(0, 8);
    const body = `收卡登记提醒：${identifierText} 未登记工作分支。写码卡请补 issue start --branch <分支名>（工作树/基线/会话一并登记）；纯调研/讨论卡可忽略本提醒。`;
    const existing = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorType, "system"),
        eq(issueComments.body, body),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return;
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      body,
      presentation: { kind: "progress_note", tone: "info", detailsDefaultOpen: false },
    });
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "branch reminder failed (transition unaffected)");
  }
}
