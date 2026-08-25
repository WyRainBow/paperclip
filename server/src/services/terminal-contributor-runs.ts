import { and, desc, eq, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * Terminal contributor sessions are external AI terminals (claude/codex/zcode
 * running in the operator's own shell) that authenticate with a
 * `terminal_contributor` agent API key instead of a Paperclip-spawned run.
 * Paperclip's write paths attribute every agent mutation to a heartbeat run,
 * so a run-less contributor gets a synthetic session run: one row per agent
 * per reuse window, reused while active. All existing downstream machinery
 * (cross-issue caps, audit attribution, decision provenance) then applies
 * unchanged — the terminal session simply *is* the run.
 */
const REUSE_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function ensureTerminalContributorRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    keyId: string;
    keyName?: string | null;
    responsibleUserId?: string | null;
  },
): Promise<string> {
  const cutoff = new Date(Date.now() - REUSE_WINDOW_MS);
  const existing = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.invocationSource, "terminal_contributor"),
        gt(heartbeatRuns.updatedAt, cutoff),
      ),
    )
    .orderBy(desc(heartbeatRuns.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    await db
      .update(heartbeatRuns)
      .set({ updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(heartbeatRuns)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "terminal_contributor",
      triggerDetail: input.keyName ?? null,
      status: "running",
      responsibleUserId: input.responsibleUserId ?? null,
      startedAt: new Date(),
      contextSnapshot: { kind: "terminal_contributor", keyId: input.keyId },
    })
    .returning({ id: heartbeatRuns.id });
  return created.id;
}
