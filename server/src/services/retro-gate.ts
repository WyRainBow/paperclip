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

export interface FrictionSignal {
  key: "rollback" | "blocked" | "review_rounds" | "recovery" | "down_votes" | "watchdog";
  count: number;
  points: number;
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

/**
 * Count `issue.updated` activity rows whose details describe a given status
 * transition. The update path logs `details.status` (the new value) and
 * `details._previous.status` (the old value) for every status change. Pass
 * `"*"` for either side to leave that side unconstrained.
 */
async function countStatusTransitions(
  db: Db,
  issueId: string,
  from: string | "*",
  to: string | "*",
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
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
    ));
  return Number(rows[0]?.count ?? 0);
}

export async function computeFrictionScore(db: Db, companyId: string, issueId: string): Promise<FrictionScore> {
  const [
    reviewRollbacks,
    blockedEntries,
    reviewRoundDocs,
    recoveryCount,
    downVoteCount,
    watchdogRows,
  ] = await Promise.all([
    countStatusTransitions(db, issueId, "in_review", "in_progress"),
    countStatusTransitions(db, issueId, "*", "blocked"),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.issueId, issueId),
        sql`${issueDocuments.key} ~ '^review-r([2-9]|[1-9][0-9]+)$'`,
      ))
      .then((rows) => Number(rows[0]?.count ?? 0)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(feedbackVotes)
      .where(and(
        eq(feedbackVotes.companyId, companyId),
        eq(feedbackVotes.issueId, issueId),
        eq(feedbackVotes.vote, "down"),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0)),
    db
      .select({ triggerCount: issueWatchdogs.triggerCount })
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.issueId, issueId),
      ))
      .then((rows) => rows[0] ?? null),
  ]);

  // Done reopens: transitions whose previous status was `done` and whose new
  // status is anything else. Computed directly here because the destination
  // varies.
  const reopenRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(and(
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.updated"),
      sql`${activityLog.details}->'_previous'->>'status' = 'done'`,
      sql`coalesce(${activityLog.details}->>'status', '') <> 'done'`,
    ));
  const doneReopenCount = Number(reopenRows[0]?.count ?? 0);

  const rollbackCount = reviewRollbacks + doneReopenCount;
  const watchdogTriggered = (watchdogRows?.triggerCount ?? 0) > 0;

  const signals: Array<FrictionSignal> = [];
  if (rollbackCount > 0) {
    signals.push({ key: "rollback", count: rollbackCount, points: rollbackCount * FRICTION_WEIGHTS.rollback });
  }
  if (blockedEntries > 0) {
    signals.push({ key: "blocked", count: blockedEntries, points: blockedEntries * FRICTION_WEIGHTS.blocked });
  }
  if (reviewRoundDocs > 0) {
    signals.push({ key: "review_rounds", count: reviewRoundDocs, points: FRICTION_WEIGHTS.review_rounds });
  }
  if (recoveryCount > 0) {
    signals.push({ key: "recovery", count: recoveryCount, points: FRICTION_WEIGHTS.recovery });
  }
  if (downVoteCount > 0) {
    signals.push({ key: "down_votes", count: downVoteCount, points: downVoteCount * FRICTION_WEIGHTS.perDownVote });
  }
  if (watchdogTriggered) {
    signals.push({ key: "watchdog", count: 1, points: FRICTION_WEIGHTS.watchdog });
  }

  return {
    total: signals.reduce((sum, signal) => sum + signal.points, 0),
    signals,
  };
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
}

/**
 * Score a card at close-out and, over the provisional threshold, tag it and
 * leave one note. Never throws: the transition already succeeded, and a
 * scoring failure must not turn it into a 500 after the fact.
 */
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

    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      body: [
        `这张卡走得磕绊（摩擦分 ${score.total}，阈 ${RETRO_OWED_SCORE_THRESHOLD}），这次遇到的问题是：`,
        ...problems.map((line) => `- ${line}`),
        "",
        "**要不要把这次的教训记成一条经验 wiki？**（草稿制：先出草稿你过目，批了才入库）",
        "- 回「**记**」：Agent 起草三段（什么情况适用 / 该怎么做 / 别踩什么）贴到卡上等你过目",
        "- 你回「**批**」：才正式写进团队 Wiki 的 cases/，下次干活就能被搜到；要改就直接说改哪句",
        "- 回「**跳过**」：不记，直接收卡",
        "",
        standbyLine,
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
