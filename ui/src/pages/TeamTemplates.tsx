import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { FileText, GitBranch, Scale, ClipboardList } from "lucide-react";

interface WikiPage {
  id: string;
  path: string;
  title: string;
  body: string;
}

const TEMPLATE_META: Record<string, { icon: typeof FileText; desc: string }> = {
  "templates/requirements": { icon: ClipboardList, desc: "为什么做、给谁做、边界在哪、怎么算做完" },
  "templates/tech-proposal": { icon: GitBranch, desc: "怎么做、为什么不那样做、影响面" },
  "templates/spec": { icon: FileText, desc: "照着做什么，实施前冻结的施工图" },
  "templates/decision": { icon: Scale, desc: "结构性拍板怎么写：三段正文+两槽理由" },
};

/**
 * Templates tab inside TeamWorkSpace: the four standard document templates
 * (requirements / tech-proposal / spec / decision) rendered from the wiki
 * pages under templates/. Each shows the skeleton and can be copied.
 */
export function TeamTemplates() {
  const { selectedCompanyId } = useCompany();
  const pagesQuery = useQuery({
    queryKey: ["team-templates", selectedCompanyId],
    queryFn: () => api.get<WikiPage[]>(
      `/companies/${selectedCompanyId}/team-wiki/paperclip/pages`),
    enabled: Boolean(selectedCompanyId),
  });
  const templates = (pagesQuery.data ?? []).filter((p) => p.path.startsWith("templates/"));
  const [selected, setSelected] = useState<string | null>(null);
  const active = templates.find((t) => t.path === selected) ?? null;

  return (
    <div className="flex flex-col gap-6 sm:flex-row p-6">
      <nav className="sm:w-52 sm:shrink-0" aria-label="模板列表" data-testid="template-nav">
        <p className="mb-1 px-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">模板</p>
        <ul className="space-y-0.5">
          {templates.map((t) => {
            const meta = TEMPLATE_META[t.path];
            const Icon = meta?.icon ?? FileText;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={selected === t.path}
                  onClick={() => setSelected(selected === t.path ? null : t.path)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    selected === t.path ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate">{t.title}</span>
                    {meta && <span className="mt-0.5 block text-(length:--text-micro) leading-4">{meta.desc}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {active ? (
          <div className="rounded-xl border border-border p-4">
            <h2 className="text-lg font-semibold text-foreground">{active.title}</h2>
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-4 font-mono text-xs leading-5">{active.body}</pre>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(active.body)}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              复制模板
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">选一个模板查看骨架，可一键复制。</p>
        )}
      </div>
    </div>
  );
}
