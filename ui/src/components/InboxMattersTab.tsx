import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import { attentionApi } from "@/api/attention";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useCompany } from "@/context/CompanyContext";
import { DecisionResolver } from "./DecisionResolver";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";
import type { Agent } from "@paperclipai/shared";

/**
 * The inbox 事项 tab (MUL-157): every attention item with its matter line —
 * the recommendation, the question, the proposed action — visible without
 * expanding, and the in-place resolver one click away. The list-style tabs
 * (mine/recent/…) stay untouched; this view shares their feed but answers
 * "what exactly is waiting" instead of "which card".
 */

const KIND_LABEL: Record<AttentionSourceKind, string> = {
  decision: "决策",
  review: "评审",
  issue_thread_interaction: "提问",
  approval: "审批",
  join_request: "加入申请",
  recovery_action: "恢复",
  productivity_review: "复核",
  blocker_attention: "阻碍",
  failed_run: "失败",
  budget_alert: "预算",
  agent_error_alert: "错误",
  experience_draft: "经验草稿",
};

const KIND_CLASS: Partial<Record<AttentionSourceKind, string>> = {
  decision: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  review: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  issue_thread_interaction: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  approval: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  recovery_action: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  failed_run: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  experience_draft: "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
};

type MatterRow = {
  item: AttentionItem;
  infoLine: string | null;
};

/** The matter line: server-fed metadata (infoLine → description → draft) or
 * the generic detail excerpt. Every row shows WHAT is waiting, not just who. */
function matterLine(item: AttentionItem): string | null {
  const meta = item.subject.metadata as Record<string, unknown> | undefined;
  for (const key of ["infoLine", "description", "draft"]) {
    const raw = meta?.[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      const text = raw.trim();
      if (key === "draft") return `草稿：${text}`;
      return key === "infoLine" ? text : `摘要：${text}`;
    }
  }
  const excerpt = item.detail && item.detail.kind === "generic" ? item.detail.summaryExcerpt : null;
  return typeof excerpt === "string" && excerpt.trim().length > 0 ? excerpt.trim() : null;
}

function InboxMatterRow({
  row,
  companyId,
  agentMap,
  expanded,
  onToggle,
  onDismiss,
}: {
  row: MatterRow;
  companyId: string;
  agentMap?: Map<string, Agent>;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const { item } = row;
  const kindLabel = KIND_LABEL[item.sourceKind] ?? item.sourceKind;
  const resolver =
    item.sourceKind === "decision" ? (
      <DecisionResolver
        companyId={companyId}
        decisionId={item.subject.id}
        originIssue={item.relatedIssue}
        agentMap={agentMap}
      />
    ) : item.sourceKind === "issue_thread_interaction" ? (
      (() => {
        const issueId = (item.subject.metadata as Record<string, unknown> | undefined)?.issueId as string | undefined
          ?? item.relatedIssue?.id;
        if (!issueId) return null;
        return (
          <AttentionInteractionResolver
            companyId={companyId}
            issueId={issueId}
            interactionId={item.subject.id}
            agentMap={agentMap}
          />
        );
      })()
    ) : null;

  return (
    <li
      className="rounded-lg border border-border/60 bg-background px-4 py-3"
      data-testid="inbox-matter-row"
      data-source-kind={item.sourceKind}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-(length:--text-nano) font-semibold",
            KIND_CLASS[item.sourceKind] ?? "bg-muted text-muted-foreground",
          )}
        >
          {kindLabel}
        </span>
        {item.relatedIssue?.identifier ? (
          <span className="font-mono text-(length:--text-nano) text-muted-foreground">{item.relatedIssue.identifier}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.subject.title}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* The matter line — the whole point of this tab (MUL-157). */}
      {row.infoLine ? (
        <p className="mt-1.5 line-clamp-3 text-(length:--text-compact) leading-relaxed text-foreground/80" data-testid="inbox-matter-info">
          {row.infoLine}
        </p>
      ) : null}
      {resolver ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="mt-1.5 inline-flex items-center gap-1 text-(length:--text-nano) font-semibold text-primary hover:underline"
          data-testid="inbox-matter-expand"
        >
          {expanded ? "收起" : item.sourceKind === "decision" ? "展开裁决" : "展开作答"}
          <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      ) : item.subject.href ? (
        <a
          href={item.subject.href}
          className="mt-1.5 inline-block text-(length:--text-nano) font-semibold text-primary hover:underline"
        >
          前往处理 →
        </a>
      ) : null}
      {expanded && resolver ? (
        <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3" data-testid="inbox-matter-resolver">
          {resolver}
        </div>
      ) : null}
    </li>
  );
}

export function InboxMattersTab({ onDismiss }: { onDismiss?: (item: AttentionItem) => void }) {
  const { selectedCompanyId } = useCompany();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const { data: feed, isLoading } = useQuery({
    // Shares the WhatNeedsMe attention prefix so a decision/interaction
    // mutation invalidates both; the suffix keeps this tab's no-dismissed
    // view distinct from that page's curtain needs.
    queryKey: [...queryKeys.attention(selectedCompanyId ?? ""), "inbox-matters"],
    queryFn: () => attentionApi.list(selectedCompanyId!, { all: true }),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!, { includeTerminated: true }),
    enabled: Boolean(selectedCompanyId),
  });
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const rows: MatterRow[] = useMemo(
    () => (feed?.items ?? []).map((item) => ({ item, infoLine: matterLine(item) })),
    [feed],
  );

  const dismiss = onDismiss ?? (() => {});

  return (
    <div className="space-y-3" data-testid="inbox-matters-tab">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">加载事项…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有在等你的事项。</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ item }) => (
            <InboxMatterRow
              key={item.dedupKey ?? item.subject.id}
              row={{ item, infoLine: matterLine(item) }}
              companyId={selectedCompanyId ?? ""}
              agentMap={agentMap}
              expanded={expandedKeys.has(item.dedupKey ?? item.subject.id)}
              onToggle={() =>
                setExpandedKeys((prev) => {
                  const key = item.dedupKey ?? item.subject.id;
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              onDismiss={() => dismiss(item)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
