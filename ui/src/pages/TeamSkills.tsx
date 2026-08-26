import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { companySkillsApi } from "../api/companySkills";
import { chineseTimestamp } from "@/lib/utils";

/**
 * The dedicated Team Skills view inside TeamWorkSpace: the company skill
 * library only, as a lean list. Full management (versions, tests, attach)
 * stays on /skills; each card links into it.
 */
export function TeamSkills() {
  const { selectedCompanyId } = useCompany();
  const skillsQuery = useQuery({
    queryKey: ["team-skills", selectedCompanyId],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const skills = (skillsQuery.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  // Ownership by key prefix: company/ = migrated team assets, paperclipai/ =
  // app-shipped, plugin/ = plugin-provided.
  const groupOf = (key: string) =>
    key.startsWith("company/") ? "team" : key.startsWith("paperclipai/") ? "builtin" : "plugin";
  const counts = { all: skills.length, team: 0, builtin: 0, plugin: 0 };
  for (const skill of skills) counts[groupOf(skill.key)] += 1;
  const TABS = [
    { id: "all", label: `全部 ${counts.all}` },
    { id: "team", label: `团队资产 ${counts.team}` },
    { id: "builtin", label: `Paperclip 内置 ${counts.builtin}` },
    { id: "plugin", label: `插件 ${counts.plugin}` },
  ] as const;
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const visible = tab === "all" ? skills : skills.filter((skill) => groupOf(skill.key) === tab);

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">TeamSkill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          公司技能库（团队共同资产）。完整管理（版本/测试/挂载到 agent）在 <Link to="/skills" className="text-primary underline-offset-2 hover:underline">Skills</Link>。
        </p>
      </div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border pb-2" data-testid="team-skill-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${tab === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {skillsQuery.isLoading ? <p className="text-xs text-muted-foreground">加载…</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((skill) => (
          <Link
            key={skill.id}
            to={`/skills/${skill.id}`}
            className="rounded-xl border border-border p-4 transition-colors hover:bg-accent/40"
            data-testid="team-skill-card"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-foreground">{skill.name}</p>
              <span className="shrink-0 rounded-full border border-border px-2 py-px text-(length:--text-micro) text-muted-foreground">
                {groupOf(skill.key) === "team" ? "团队资产" : groupOf(skill.key) === "builtin" ? "Paperclip 内置" : "插件"}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">
              {skill.description ?? "（无描述）"}
            </p>
          </Link>
        ))}
      </div>
      {!skillsQuery.isLoading && visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">公司技能库还是空的。</p>
      ) : null}
    </div>
  );
}
