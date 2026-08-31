import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { decisionsApi, type DecisionListItem } from "@/api/decisions";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { DecisionResolver } from "./DecisionResolver";

type DecisionRelation = "origin" | "target";

interface PanelDecision {
  decision: DecisionListItem;
  relation: DecisionRelation;
}

/**
 * Decisions raised while working this issue, plus decisions whose effects
 * target it. One template everywhere: this panel renders the same canonical
 * DecisionCard the company-wide surfaces use (options, recommendation, decide
 * inputs included) via DecisionResolver — a reader gets the identical card
 * here and on the Decisions page. The relation caption is panel-local chrome:
 * it says why the card is here without changing the card itself.
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
  const originQuery = useQuery({
    queryKey: ["issues", issueId, "decisions"],
    queryFn: () => decisionsApi.list(companyId, { originIssueId: issueId, limit: 100 }),
    enabled: Boolean(companyId && issueId),
  });
  const targetQuery = useQuery({
    queryKey: queryKeys.decisions.forTargetIssue(companyId, issueId),
    queryFn: () => decisionsApi.list(companyId, { targetIssueId: issueId, limit: 100 }),
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

  // A decision can both originate here and be targeted at it; origin is the
  // stronger claim, so it wins the dedupe.
  const items = useMemo<PanelDecision[]>(() => {
    const byId = new Map<string, PanelDecision>();
    for (const decision of originQuery.data ?? []) {
      byId.set(decision.id, { decision, relation: "origin" });
    }
    for (const decision of targetQuery.data ?? []) {
      if (!byId.has(decision.id)) byId.set(decision.id, { decision, relation: "target" });
    }
    return [...byId.values()].sort((a, b) => b.decision.createdAt.localeCompare(a.decision.createdAt));
  }, [originQuery.data, targetQuery.data]);

  if (originQuery.isLoading || targetQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">加载决策…</p>;
  }

  if (originQuery.error || targetQuery.error) {
    return <p className="text-xs text-muted-foreground">决策加载失败，刷新页面重试。</p>;
  }

  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        这张卡上还没有决策。凡「我们决定了 X」都应该落一条、选项、推荐人和裁决理由会一起归档。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {items.map(({ decision, relation }) => (
        <div key={decision.id}>
          <p className="mb-1 text-xs text-muted-foreground">
            {relation === "origin" ? "在本卡发起" : "效果指向本卡"}
          </p>
          <DecisionResolver
            companyId={companyId}
            decisionId={decision.id}
            agentMap={mergedAgentMap}
            initialDecision={{ ...decision, executions: decision.executions ?? [] }}
          />
        </div>
      ))}
    </div>
  );
}
