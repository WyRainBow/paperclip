import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Loader2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AgentIcon, agentCustomIcon } from "@/components/AgentIconPicker";
import type { Agent } from "@paperclipai/shared";

/**
 * The Logo tab (user 2026-08-29): one place to give every agent its official
 * product mark. An agent's logo is two fields — `icon` (a lucide name, the
 * fallback) and `metadata.customIcon` (a URL, the real brand mark that wins
 * everywhere). This page sets both in one click so no surface ever has to
 * guess: official preset → customIcon + icon; picker selection → icon only;
 * clear → back to initials.
 */
const OFFICIAL_PRESETS: Array<{ key: string; label: string; url: string; icon: string }> = [
  { key: "claude", label: "Claude", url: "/brands/claude-starburst.png", icon: "sparkles" },
  { key: "openai", label: "Codex", url: "/brands/openai.svg", icon: "terminal" },
  { key: "zcode", label: "Zcode", url: "/brands/zcode-mark.jpeg", icon: "zap" },
];

export function AgentLogos() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const { data: agents, isLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!, { includeTerminated: true }),
    enabled: Boolean(selectedCompanyId),
  });

  setBreadcrumbs([{ label: "Logo" }]);

  const applyMutation = useMutation({
    mutationFn: async ({ agent, preset }: { agent: Agent; preset: typeof OFFICIAL_PRESETS[number] | null }) => {
      const metadata = { ...(agent.metadata ?? {}) };
      if (preset) {
        metadata.customIcon = preset.url;
      } else {
        delete metadata.customIcon;
      }
      return agentsApi.update(agent.id, {
        icon: preset ? preset.icon : null,
        metadata,
      }, selectedCompanyId ?? undefined);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId ?? "") });
    },
  });

  const rows = (Array.isArray(agents) ? agents : []).filter((a) => a.status !== "terminated");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6" data-testid="agent-logos-page">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <ImageIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
          Logo
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每个 Agent 一处配置、全站生效：官方 logo（气泡/顶栏/讨论/列表）、备用图标、清空回退。
        </p>
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> 加载 agents…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">这个公司还没有 agent。</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((agent) => {
            const custom = agentCustomIcon(agent);
            const activePreset = custom ? OFFICIAL_PRESETS.find((p) => p.url === custom) ?? null : null;
            return (
              <li
                key={agent.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3"
                data-testid="agent-logo-row"
              >
                {/* Current logo, rendered exactly the way every other surface renders it. */}
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-background">
                  <AgentIcon icon={agent.icon} customIconUrl={custom} className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
                  <p className="text-(length:--text-nano) text-muted-foreground">
                    {activePreset ? `官方 ${activePreset.label} logo` : custom ? `自定义 ${custom}` : agent.icon ? `图标 ${agent.icon}` : "无（首字母兜底）"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {OFFICIAL_PRESETS.map((preset) => {
                    const active = activePreset?.key === preset.key;
                    return (
                      <Button
                        key={preset.key}
                        size="sm"
                        variant={active ? "default" : "outline"}
                        disabled={applyMutation.isPending}
                        onClick={() => applyMutation.mutate({ agent, preset })}
                        title={`应用官方 ${preset.label} logo`}
                        data-testid={`logo-preset-${preset.key}`}
                      >
                        <img src={preset.url} alt="" className="h-3.5 w-3.5" />
                        {preset.label}
                      </Button>
                    );
                  })}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={applyMutation.isPending || (!custom && !agent.icon)}
                    onClick={() => applyMutation.mutate({ agent, preset: null })}
                    title="清空 logo，回退到首字母"
                    data-testid={`logo-clear-${agent.id.slice(0, 8)}`}
                  >
                    清空
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
