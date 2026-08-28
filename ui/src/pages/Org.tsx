import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ChevronRight, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { AgentIcon, agentCustomIcon } from "../components/AgentIconPicker";
import type { Agent } from "@paperclipai/shared";

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
  agentMap,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
  agentMap: Map<string, Agent>;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode key={node.id} node={node} depth={depth} hrefFn={hrefFn} agentMap={agentMap} />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
  agentMap,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
  agentMap: Map<string, Agent>;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;
  // The org endpoint returns id/name/role only, so the provider logo has to be
  // joined in from the agents list — without it every row is a bare status dot.
  const agent = agentMap.get(node.id) ?? null;

  return (
    <div>
      <Link
        to={hrefFn(node.id)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer hover:bg-accent/50 no-underline text-inherit"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            className="p-0.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            // Gallery feedback r3: route through the canonical agentStatusDot
            // map (identical hues for existing keys; adds the blue running dot).
            agentStatusDot[node.status] ?? agentStatusDotDefault,
          )}
        />
        <AgentIcon
          icon={agent?.icon}
          customIconUrl={agentCustomIcon(agent)}
          className="h-4 w-4 shrink-0 text-muted-foreground"
        />
        <span className="font-medium flex-1">{node.name}</span>
        <span className="text-xs text-muted-foreground">{node.role}</span>
        <StatusBadge status={node.status} />
      </Link>
      {hasChildren && expanded && (
        <OrgTree nodes={node.reports} depth={depth + 1} hrefFn={hrefFn} agentMap={agentMap} />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", selectedCompanyId, "with-terminated"],
    queryFn: () => agentsApi.list(selectedCompanyId!, { includeTerminated: true }),
    enabled: !!selectedCompanyId,
  });
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message="No agents in the organization. Create agents to build your org chart."
        />
      )}

      {data && data.length > 0 && (
        <div className="border border-border py-1">
          <OrgTree nodes={data} hrefFn={(id) => `/agents/${id}`} agentMap={agentMap} />
        </div>
      )}
    </div>
  );
}
