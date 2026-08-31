import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";

/**
 * 认领门禁扩面 (MUL-443, 老板令 2026-08-31: 卡上除正文外的改动就算接卡).
 *
 * MUL-72 gated the two writes that were leaking work by nobody — progress notes
 * and status advances. Documents and decisions are deliverables too, and an
 * agent could file a tech-proposal or open a decision on a card whose Driving
 * was empty.
 *
 * What that actually costs is worth stating precisely, because it is not
 * anonymity: `issue_documents` and `document_revisions` both record
 * `createdByAgentId`, so the artifact always names its author. The gap is that
 * the CARD still reads as unowned, so the board sees no one working it and a
 * second agent takes it — the same collision MUL-72 closed for progress notes.
 *
 * Chat comments and the description stay open on purpose. Comments are the
 * conversation channel, and gating them would stop an agent from asking a
 * question about a card it has not taken. The description is the thin
 * always-overwritten summary, not a deliverable.
 *
 * Lives in a service rather than in either route because the two writes it
 * guards are in different route files, and one copy of the condition is the
 * only way they stay the same rule.
 */
export type ClaimGateDeliverable = "document" | "decision";

export type ClaimGateDenial = {
  status: 409;
  body: {
    error: string;
    details: { code: "issue_unclaimed"; issueId: string; deliverable: ClaimGateDeliverable };
  };
};

/** A card is claimed when either slot is filled — same test MUL-72 uses. */
export function isIssueClaimed(issue: { assigneeAgentId: string | null; drivingAgentId: string | null }): boolean {
  return issue.assigneeAgentId != null || issue.drivingAgentId != null;
}

/**
 * The denial to send, or null to let the write through. Board callers always
 * pass: the gate exists to keep agent work attributed, and the board is the
 * one actor whose writes are already accountable to a person.
 */
export function unclaimedDeliverableDenial(input: {
  actorType: string;
  issue: { id: string; identifier?: string | null; assigneeAgentId: string | null; drivingAgentId: string | null };
  deliverable: ClaimGateDeliverable;
}): ClaimGateDenial | null {
  if (input.actorType !== "agent") return null;
  if (isIssueClaimed(input.issue)) return null;
  const what = input.deliverable === "document" ? "writing a document" : "creating a decision";
  return {
    status: 409,
    body: {
      error: `Unclaimed issue: ${what} requires an assignee or Driving — run \`issue claim ${input.issue.identifier ?? input.issue.id}\` first`,
      details: { code: "issue_unclaimed", issueId: input.issue.id, deliverable: input.deliverable },
    },
  };
}

/**
 * Load just the three columns the gate reads. The decision routes never had a
 * reason to fetch the origin issue before, so they get this instead of a full
 * issue read.
 */
export async function loadIssueClaimState(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<{ id: string; identifier: string | null; assigneeAgentId: string | null; drivingAgentId: string | null } | null> {
  const [row] = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      assigneeAgentId: issues.assigneeAgentId,
      drivingAgentId: issues.drivingAgentId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  return row ?? null;
}
