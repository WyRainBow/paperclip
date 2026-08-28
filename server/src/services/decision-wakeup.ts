import type { DecisionServiceOptions } from "./decisions.js";
import type { ArchiveNotificationBatch } from "./decision-retention.js";

type HeartbeatWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
  },
) => Promise<unknown>;

/**
 * Connect decision continuations to the heartbeat runtime only while that
 * runtime is enabled. A disabled scheduler must not accept wakeups that it
 * cannot own for the rest of the process lifetime.
 */
export function createDecisionWakeOriginAgent(
  wakeup: HeartbeatWakeup | null,
): DecisionServiceOptions["wakeOriginAgent"] {
  if (!wakeup) return async () => null;
  return async (input) => {
    try {
      return await wakeup(input.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: `decision_${input.outcome}`,
        payload: {
          issueId: input.issueId,
          decisionId: input.decisionId,
          outcome: input.outcome,
        },
      });
    } catch (error) {
      // A continuation that cannot be delivered must not undo the verdict.
      // Terminal agents (claude/codex/zcode in the operator's own shell) have no
      // launchable adapter, so waking them always fails — and because the wake
      // ran inside the decide path, every such decision came back as
      // "409 adapter_not_launchable" even though it had already been recorded.
      // Worse, a pending continuation replayed at boot took the whole server
      // down with it. The verdict is the durable part; the wake is best-effort,
      // and a human returning to the card is the fallback (MUL-104 / MUL-113).
      console.warn(
        `[decisions] continuation wakeup skipped for agent ${input.agentId} on decision ${input.decisionId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  };
}

export function createDecisionRetentionNotifyOriginAgent(
  wakeup: HeartbeatWakeup | null,
): (batch: ArchiveNotificationBatch) => Promise<unknown> {
  if (!wakeup) return async () => null;
  return async (batch) => wakeup(batch.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "attention_auto_archived",
    payload: {
      issueIds: [...new Set(batch.items.map((item) => item.issueId))],
      archives: batch.items.map((item) => ({
        sourceKind: item.sourceKind,
        sourceId: item.sourceId,
        archiveVersion: item.archiveVersion,
      })),
    },
  });
}
