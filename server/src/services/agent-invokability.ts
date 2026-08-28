import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { getAgentWorkEligibility, type AgentEligibilityAgent, type AgentOrgChainHealth } from "@paperclipai/shared";
import { eq } from "drizzle-orm";

type AgentStatus = (typeof agents.$inferSelect)["status"];

export type AgentOrgRow = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "name" | "reportsTo" | "status"
>;

/** Adapter fields needed to tell whether Paperclip can start this agent at all. */
export type AgentLaunchability = Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">;

/**
 * Why this exists: an agent whose adapter cannot be started is not merely
 * likely to fail — it cannot run at any point in the future without a config
 * change, so every wake-up spends a run record to rediscover that. The http
 * adapter with no url is the case seen in practice: terminal agents live in
 * the operator's own shell, so Paperclip has nothing to call, and each
 * assignment or promotion queued another guaranteed failure.
 *
 * Treat it as non-invokable up front rather than letting the adapter throw:
 * the wake-up is then recorded as skipped with a reason, instead of a failed
 * run that reads like something broke.
 */
export function adapterLaunchBlock(agent: AgentLaunchability | null | undefined): string | null {
  if (!agent) return null;
  if (agent.adapterType !== "http") return null;
  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const url = typeof config.url === "string" ? config.url.trim() : "";
  return url ? null : "HTTP adapter has no url, so Paperclip cannot start this agent";
}

export type AgentInvokabilityBlockReason =
  | "missing"
  | "paused"
  | "terminated"
  | "pending_approval"
  | "unknown_status"
  | "manager_missing"
  | "manager_company_mismatch"
  | "manager_terminated"
  | "reporting_cycle"
  | "reporting_chain_too_deep"
  | "adapter_not_launchable";

export type AgentInvokability =
  | { invokable: true }
  | {
      invokable: false;
      reason: AgentInvokabilityBlockReason;
      message: string;
      details: Record<string, unknown>;
      invalidOrgChain: boolean;
    };

export const DIRECT_NON_INVOKABLE_STATUSES = new Set<AgentStatus>([
  "paused",
  "terminated",
  "pending_approval",
]);

function blocked(
  reason: AgentInvokabilityBlockReason,
  message: string,
  details: Record<string, unknown>,
  invalidOrgChain = false,
): AgentInvokability {
  return { invokable: false, reason, message, details, invalidOrgChain };
}

function statusBlockReason(status: AgentStatus): AgentInvokabilityBlockReason | null {
  if (status === "paused") return "paused";
  if (status === "terminated") return "terminated";
  if (status === "pending_approval") return "pending_approval";
  return null;
}

function toEligibilityAgent(row: AgentOrgRow): AgentEligibilityAgent {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    status: row.status,
    reportsTo: row.reportsTo,
  };
}

function invalidChainReason(health: AgentOrgChainHealth): AgentInvokabilityBlockReason {
  if (health.reason === "terminated_ancestor") return "manager_terminated";
  if (health.reason === "cycle") return "reporting_cycle";
  return "manager_missing";
}

export function evaluateAgentInvokability(
  agent: (AgentOrgRow & Partial<AgentLaunchability>) | null | undefined,
  companyAgents: AgentOrgRow[],
): AgentInvokability {
  if (!agent) {
    return blocked("missing", "Agent no longer exists", {}, false);
  }

  // Checked before status and org chain: a launch that cannot succeed is worth
  // reporting as such even when the agent is otherwise in good standing.
  const launchBlock = "adapterType" in agent ? adapterLaunchBlock(agent as AgentLaunchability) : null;
  if (launchBlock) {
    return blocked(
      "adapter_not_launchable",
      launchBlock,
      { agentId: agent.id, adapterType: (agent as AgentLaunchability).adapterType },
      false,
    );
  }

  const eligibility = getAgentWorkEligibility({
    agent: toEligibilityAgent(agent),
    agents: companyAgents.map(toEligibilityAgent),
  });

  if (eligibility.invokable) return { invokable: true };

  const directStatusReason = eligibility.invokabilityReason === "unknown_status"
    ? "unknown_status"
    : statusBlockReason(agent.status);
  if (directStatusReason) {
    return blocked(
      directStatusReason,
      "Agent is not invokable in its current state",
      { agentId: agent.id, agentStatus: agent.status },
      false,
    );
  }

  const health = eligibility.orgChainHealth;
  const firstInvalidAncestor = health.firstInvalidAncestor;
  return blocked(
    invalidChainReason(health),
    "Agent is not invokable because its reporting chain is invalid",
    {
      agentId: agent.id,
      managerId: firstInvalidAncestor?.id ?? null,
      managerStatus: firstInvalidAncestor?.status ?? null,
      reportingChainAgentIds: health.fullChain
        .filter((entry) => entry.relation === "ancestor")
        .map((entry) => entry.id),
      orgChainHealth: health,
    },
    true,
  );
}

export async function evaluateAgentInvokabilityFromDb(
  db: Db,
  agent: (AgentOrgRow & Partial<AgentLaunchability>) | null | undefined,
): Promise<AgentInvokability> {
  if (!agent) return evaluateAgentInvokability(agent, []);
  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, agent.companyId));
  return evaluateAgentInvokability(agent, companyAgents);
}

export function listInvalidOrgChainDescendantIds(
  terminatedAgentId: string,
  companyAgents: AgentOrgRow[],
): string[] {
  const byManager = new Map<string | null, AgentOrgRow[]>();
  for (const row of companyAgents) {
    const siblings = byManager.get(row.reportsTo ?? null) ?? [];
    siblings.push(row);
    byManager.set(row.reportsTo ?? null, siblings);
  }

  const invalidDescendantIds: string[] = [];
  const stack = [...(byManager.get(terminatedAgentId) ?? [])];
  const seen = new Set<string>([terminatedAgentId]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.status !== "terminated") {
      invalidDescendantIds.push(current.id);
    }
    stack.push(...(byManager.get(current.id) ?? []));
  }
  return invalidDescendantIds;
}

export function shouldCancelRunsForNonInvokableAgent(result: AgentInvokability) {
  return !result.invokable && (result.reason === "terminated" || result.invalidOrgChain);
}
