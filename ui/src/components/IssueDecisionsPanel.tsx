import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, CircleDashed, CircleSlash, Clock } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { decisionsApi, type DecisionListItem } from "@/api/decisions";
import { agentsApi } from "@/api/agents";
import { MarkdownBody } from "@/components/MarkdownBody";
import { AgentIcon, agentCustomIcon } from "@/components/AgentIconPicker";
import { absoluteTimestamp, cn } from "@/lib/utils";

/**
 * Decisions raised while working this issue. The company-wide decisions page
 * lists everything by time; this panel answers the narrower question a reader
 * of one task actually has — what was decided here, by whom, and why.
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
    <ul className="space-y-3">
      {decisions.map((decision) => (
        <DecisionRow key={decision.id} decision={decision} agentMap={mergedAgentMap} />
      ))}
    </ul>
  );
}

/**
 * One decision, open by default. The full case is what a reader of this tab
 * came for; collapsing is the exception, so the toggle starts expanded rather
 * than hiding the reasoning behind a click.
 */
function DecisionRow({
  decision,
  agentMap,
}: {
  decision: DecisionListItem;
  agentMap?: Map<string, Agent>;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <>
      {(() => {
        const chosen = decision.options.find((option) => option.id === decision.chosenOptionId) ?? null;
        const recommended = decision.options.find((option) => option.recommendedByAgentId) ?? null;
        const recommender = recommended?.recommendedByAgentId
          ? agentMap?.get(recommended.recommendedByAgentId) ?? null
          : null;
        const decider = decision.decidedByAgentId ? agentMap?.get(decision.decidedByAgentId) ?? null : null;
        const rationale = decision.inputValues?.rationale?.trim();
        const constraints = decision.inputValues?.constraints?.trim();
        const status = STATUS_META[decision.status] ?? STATUS_META.open!;
        const StatusIcon = status.icon;

        return (
          <li className="rounded-lg border border-border p-4">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="flex w-full items-start justify-between gap-3 text-left"
            >
              <div className="min-w-0">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                  <ChevronDown
                    className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")}
                    aria-hidden
                  />
                  {decision.title}
                </h4>
                {decision.ruleKey && (
                  <p className="mt-0.5 font-mono text-(length:--text-micro) text-muted-foreground">{decision.ruleKey}</p>
                )}
              </div>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-(length:--text-micro)",
                  status.className,
                )}
              >
                <StatusIcon className="h-3 w-3" aria-hidden />
                {status.label}
              </span>
            </button>

            {expanded ? (
            <>
            {chosen ? (
              <p className="mt-2 text-sm">
                <span className="text-muted-foreground">选了 </span>
                <span className="font-medium">{chosen.label}</span>
                {decider && <span className="text-muted-foreground"> · 由 {decider.name} 裁决</span>}
                {decision.decidedAt && (
                  <span className="tabular-nums text-muted-foreground"> · {absoluteTimestamp(decision.decidedAt)}</span>
                )}
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">尚未裁决。</p>
            )}

            {/* The recommendation is worth showing even after the verdict: a
                verdict that went against the recommendation is the interesting
                case, and it is invisible if only the chosen option is shown. */}
            {recommended && (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
                {recommender ? (
                  <AgentIcon
                    icon={recommender.icon}
                    customIconUrl={agentCustomIcon(recommender)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                ) : null}
                <span className="font-medium text-foreground">{recommender?.name ?? "提案 agent"}</span>
                推荐 {recommended.label}
                {chosen && chosen.id !== recommended.id ? (
                  <span className="text-amber-700 dark:text-amber-300">· 裁决未采纳</span>
                ) : null}
              </p>
            )}

            {recommended && (recommended.recommendationReason ?? recommended.description)?.trim() && (
              <p className="mt-1 text-(length:--text-micro) text-muted-foreground">
                <span className="font-medium text-foreground">推荐理由：</span>
                {recommended.recommendationReason ?? recommended.description}
              </p>
            )}

            {rationale && (
              <div className="mt-2 border-l-2 border-border pl-3 text-sm text-muted-foreground">
                <MarkdownBody>{rationale}</MarkdownBody>
              </div>
            )}

            {constraints && (
              <p className="mt-2 text-(length:--text-micro) text-muted-foreground">
                <span className="font-medium text-foreground">附加约束：</span>
                {constraints}
              </p>
            )}

            {decision.body?.trim() && (
              <div className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
                <MarkdownBody>{decision.body}</MarkdownBody>
              </div>
            )}
            </>
            ) : null}
          </li>
        );
      })()}
    </>
  );
}

const STATUS_META: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  open: {
    label: "待裁决",
    icon: CircleDashed,
    className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  decided: {
    label: "已裁决",
    icon: CheckCircle2,
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  expired: {
    label: "已过期",
    icon: Clock,
    className: "border-border bg-muted/40 text-muted-foreground",
  },
  cancelled: {
    label: "已作废",
    icon: CircleSlash,
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};
