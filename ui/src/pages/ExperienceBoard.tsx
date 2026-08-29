/**
 * 经验看板 (MUL-133 需求三): one row per card that has been friction-scored,
 * tagged retro-owed, or sedimented — the boss's "which tasks deserve a second
 * look" surface. Layout borrowed from OV's tasks board: status chips up top,
 * one dense row per task, badges instead of prose.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge, NotebookPen } from "lucide-react";
import { experienceBoardApi, type ExperienceBoardRow } from "@/api/experienceBoard";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

const SIGNAL_LABELS: Record<string, string> = {
  rollback: "被打回重做过",
  blocked: "卡在 blocked 等过",
  review_rounds: "评审打到第二轮以后",
  recovery: "动用过 recovery 换手",
  down_votes: "收到差评",
  watchdog: "watchdog 报过警",
};

const STATUS_LABELS: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  in_review: "送审",
  done: "已收卡",
  blocked: "被阻塞",
  cancelled: "已取消",
  backlog: "积压",
};

function frictionBadgeVariant(total: number): "default" | "destructive" | "secondary" {
  if (total >= 40) return "destructive";
  if (total >= 20) return "default";
  return "secondary";
}

export function ExperienceBoard() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const board = useQuery({
    queryKey: queryKeys.experienceBoard(companyId ?? "none"),
    queryFn: () => experienceBoardApi(companyId as string),
    enabled: Boolean(companyId),
  });

  useBreadcrumbsSetter(setBreadcrumbs);

  if (board.isLoading) return <PageSkeleton />;
  const rows = board.data?.rows ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Gauge className="h-5 w-5" />
          经验看板
        </h1>
        <p className="text-sm text-muted-foreground">
          每行一张被记过摩擦分的卡——分高先看、有 retro-owed 的欠一次复盘、已沉淀的标了出处。
          待沉淀 {board.data?.retroOwedCount ?? 0} 张。
        </p>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={NotebookPen}
          title="还没有卡被记过分"
          message="卡送审或收卡时会自动算摩擦分；过阈的卡会出现在这里等你决定要不要沉淀经验。"
        />
      ) : (
        <Card className="divide-y divide-border">
          {rows.map((row) => (
            <BoardRow key={row.issueId} row={row} />
          ))}
        </Card>
      )}
    </div>
  );
}

function BoardRow({ row }: { row: ExperienceBoardRow }) {
  const href = row.identifier ? `/${row.identifier.split("-")[0]}/issues/${row.identifier}` : null;
  return (
    <div className="flex flex-col gap-1.5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={href ?? "#"}
          className="text-sm font-medium text-foreground hover:underline"
        >
          {row.identifier ?? row.issueId.slice(0, 8)} · {row.title}
        </a>
        <Badge variant="outline">{STATUS_LABELS[row.status] ?? row.status}</Badge>
        <Badge variant={frictionBadgeVariant(row.frictionTotal)}>摩擦分 {row.frictionTotal}</Badge>
        {row.retroOwed ? <Badge variant="destructive">欠复盘</Badge> : null}
        {row.sediment ? (
          <Badge variant="secondary">已沉淀 · {row.sediment.path}</Badge>
        ) : (
          <Badge variant="outline">未沉淀</Badge>
        )}
      </div>
      {row.frictionSignals.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {row.frictionSignals
            .map((signal) => `${SIGNAL_LABELS[signal.key] ?? signal.key} ×${signal.count}（+${signal.points}）`)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

/** Static breadcrumbs; kept in a sub-hook so the loading early-return stays clean. */
function useBreadcrumbsSetter(setBreadcrumbs: ReturnType<typeof useBreadcrumbs>["setBreadcrumbs"]) {
  useEffect(() => {
    setBreadcrumbs([{ label: "经验看板" }]);
  }, [setBreadcrumbs]);
}
