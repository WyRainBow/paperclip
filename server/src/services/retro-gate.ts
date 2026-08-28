import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  documents,
  feedbackVotes,
  issueComments,
  issueDocuments,
  issueLabels,
  issueRecoveryActions,
  issueWatchdogs,
  issues,
  labels,
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
  rollback: "状态回退",
  blocked: "进过 blocked",
  review_rounds: "评审打到第 2 轮及以后",
  recovery: "动用过 recovery",
  down_votes: "收到 down 票",
  watchdog: "watchdog 触发过",
};

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

    const breakdown = score.signals
      .map((signal) => `${SIGNAL_LABELS[signal.key]} ×${signal.count}（+${signal.points}）`)
      .join("、");
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      body: [
        `收尾闸门（${input.enteredStatus === "done" ? "收卡" : "送审"}）：这张卡摩擦分 ${score.total}（阈 ${RETRO_OWED_SCORE_THRESHOLD}），已打 \`retro-owed\` 标签。`,
        `触发信号：${breakdown}。`,
        "分数只说明走得磕绊，不说明一定有值得沉淀的东西——跑 team-interview-retro 时以卡上事实为准，复盘结论由人裁决。",
      ].join("\n\n"),
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
