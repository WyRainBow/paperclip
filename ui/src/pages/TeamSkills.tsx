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

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">TeamSkill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          公司技能库（团队共同资产）。完整管理（版本/测试/挂载到 agent）在 <Link to="/skills" className="text-primary underline-offset-2 hover:underline">Skills</Link>。
        </p>
      </div>
      {skillsQuery.isLoading ? <p className="text-xs text-muted-foreground">加载…</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {skills.map((skill) => (
          <Link
            key={skill.id}
            to={`/skills/${skill.id}`}
            className="rounded-xl border border-border p-4 transition-colors hover:bg-accent/40"
            data-testid="team-skill-card"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-foreground">{skill.name}</p>
              <span className="shrink-0 rounded-full border border-border px-2 py-px text-(length:--text-micro) text-muted-foreground">
                {skill.sourceType}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">
              {skill.description ?? "（无描述）"}
            </p>
          </Link>
        ))}
      </div>
      {!skillsQuery.isLoading && skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">公司技能库还是空的。</p>
      ) : null}
    </div>
  );
}
