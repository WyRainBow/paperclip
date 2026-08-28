import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { Link } from "@/lib/router";
import type { Agent, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/ui/button";

const ARCHIVE_PAGE_SIZE = 200;

function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

/**
 * The archive area (MUL-109). Issues cannot be deleted — the database refuses
 * it — so every card that leaves the board lands here, with who archived it,
 * when, and why, and a way back.
 */
export function IssuesArchive() {
  const { selectedCompanyId } = useCompany();
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: t("Archive") }]);
  }, [setBreadcrumbs, t]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const archiveQueryKey = useMemo(
    () => [...queryKeys.issues.list(selectedCompanyId!), "archived"],
    [selectedCompanyId],
  );

  const { data: issues, isLoading, error } = useQuery({
    queryKey: archiveQueryKey,
    queryFn: () => issuesApi.list(selectedCompanyId!, {
      archived: "only",
      limit: ARCHIVE_PAGE_SIZE,
      sortField: "updated",
      sortDir: "desc",
    }),
    enabled: !!selectedCompanyId,
  });

  const restore = useMutation({
    mutationFn: (id: string) => issuesApi.unarchive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  const agentName = (agentId: string | null | undefined) =>
    (agents as Agent[] | undefined)?.find((candidate) => candidate.id === agentId)?.name ?? agentId ?? "";

  const archivedBy = (issue: Issue): string => {
    if (issue.archivedByType === "agent") return agentName(issue.archivedByAgentId);
    if (issue.archivedByType === "user") return issue.archivedByUserId ?? t("A user");
    return t("System");
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Archive} message={t("Select a company to view the archive.")} />;
  }
  if (error) {
    return <EmptyState icon={Archive} message={(error as Error).message} />;
  }
  if (!isLoading && (issues ?? []).length === 0) {
    return <EmptyState icon={Archive} message={t("Nothing archived yet.")} />;
  }

  return (
    <div className="p-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-foreground">{t("Archive")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Tasks are never deleted. Archived cards live here and can be restored to the board.")}
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t("Task")}</th>
              <th className="px-3 py-2 font-medium">{t("Archived")}</th>
              <th className="px-3 py-2 font-medium">{t("By")}</th>
              <th className="px-3 py-2 font-medium">{t("Reason")}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(issues ?? []).map((issue) => (
              <tr key={issue.id} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <Link to={`/issues/${issue.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                    {issue.identifier}
                  </Link>
                  <span className="ml-2 text-foreground">{issue.title}</span>
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{formatDateTime(issue.archivedAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">{archivedBy(issue)}</td>
                <td className="px-3 py-2 text-muted-foreground">{issue.archivedReason ?? ""}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(issue.id)}
                  >
                    {t("Restore")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
