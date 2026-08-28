import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { decisionsApi } from "@/api/decisions";
import { agentsApi } from "@/api/agents";
import { DecisionResolver } from "./DecisionResolver";

/**
 * Decisions raised while working this issue. One template everywhere: this
 * panel renders the same canonical DecisionCard the company-wide surfaces
 * use (options, recommendation, decide inputs included) via DecisionResolver —
 * a reader gets the identical card here and on the Decisions page.
 */
export function IssueDecisionsPanel({
  companyId,
  issueId,
  agentMap,
}: {
  companyId: string;
  issueId: string;
  agentMap?: Map<string, Agent>;
}) {
  const decisionsQuery = useQuery({
    queryKey: ["issues", issueId, "decisions"],
    queryFn: () => decisionsApi.list(companyId, { originIssueId: issueId, limit: 100 }),
    enabled: Boolean(companyId && issueId),
  });

  // Terminated agents still get named on decision records: the active-only
  // agentMap prop would turn a terminated recommender into a raw fallback.
  const terminatedInclusiveAgents = useQuery({
    queryKey: ["agents", companyId, "with-terminated"],
    queryFn: () => agentsApi.list(companyId, { includeTerminated: true }),
    enabled: Boolean(companyId),
  });
  const mergedAgentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of terminatedInclusiveAgents.data ?? []) map.set(agent.id, agent);
    for (const [id, agent] of agentMap ?? []) if (!map.has(id)) map.set(id, agent);
    return map;
  }, [terminatedInclusiveAgents.data, agentMap]);

  const decisions = decisionsQuery.data ?? [];

  if (decisionsQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">加载决策…</p>;
  }

  if (decisions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        这张卡上还没有决策。凡「我们决定了 X」都应该落一条、选项、推荐人和裁决理由会一起归档。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {decisions.map((decision) => (
        <DecisionResolver
          key={decision.id}
          companyId={companyId}
          decisionId={decision.id}
          agentMap={mergedAgentMap}
          initialDecision={{ ...decision, executions: decision.executions ?? [] }}
        />
      ))}
    </div>
  );
}
