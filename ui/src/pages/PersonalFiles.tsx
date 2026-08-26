import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { personalFilesApi, type PersonalFile, type PersonalFileVersionSummary } from "@/api/personal-files";
import { chineseTimestamp } from "@/lib/utils";
import { RevisionDiffDialog, revisionDiffSelection, type DiffableRevision } from "@/components/RevisionDiffDialog";

const KIND_LABELS: Record<string, string> = {
  "claude-md": "CLAUDE.md",
  "agents-md": "AGENTS.md",
  "workspace-agents": "仓库级 AGENTS.md",
};

function FileCard({ companyId, file }: { companyId: string; file: PersonalFile }) {
  const [open, setOpen] = useState(false);
  const versionsQuery = useQuery({
    queryKey: ["personal-files", file.id, "versions"],
    queryFn: () => personalFilesApi.versions(companyId, file.id),
    enabled: open,
  });
  const versions = versionsQuery.data ?? [];
  const [viewRevision, setViewRevision] = useState<PersonalFileVersionSummary | null>(null);
  const viewQuery = useQuery({
    queryKey: ["personal-files", file.id, "version", viewRevision?.revisionNumber],
    queryFn: () => personalFilesApi.version(companyId, file.id, viewRevision!.revisionNumber),
    enabled: Boolean(viewRevision),
  });
  const [diffRevisions, setDiffRevisions] = useState<DiffableRevision[] | null>(null);

  const openDiff = async (target: PersonalFileVersionSummary) => {
    const older = versions.find((v) => v.revisionNumber < target.revisionNumber) ?? null;
    const [targetFull, olderFull] = await Promise.all([
      personalFilesApi.version(companyId, file.id, target.revisionNumber),
      older ? personalFilesApi.version(companyId, file.id, older.revisionNumber) : Promise.resolve(null),
    ]);
    const revisions: DiffableRevision[] = [];
    if (olderFull) {
      revisions.push({ id: olderFull.id, revisionNumber: olderFull.revisionNumber, title: file.path, body: olderFull.content, label: olderFull.label });
    }
    revisions.push({ id: targetFull.id, revisionNumber: targetFull.revisionNumber, title: file.path, body: targetFull.content, label: targetFull.label });
    setDiffRevisions(revisions);
  };

  const selection = diffRevisions ? revisionDiffSelection(diffRevisions, diffRevisions[diffRevisions.length - 1]?.id) : { leftId: null, rightId: null };

  return (
    <div className="rounded-xl border border-border p-4" data-testid="personal-file-card">
      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="rounded-full border border-border px-2 py-px text-(length:--text-micro) text-muted-foreground">
              {KIND_LABELS[file.kind] ?? file.kind}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
          </p>
          <p className="mt-1 text-(length:--text-micro) text-muted-foreground">更新时间 {chineseTimestamp(file.updatedAt)}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "收起" : "版本"}</span>
      </button>
      {open ? (
        <ul className="mt-3 space-y-1.5">
          {versionsQuery.isLoading ? <li className="text-xs text-muted-foreground">加载版本…</li> : null}
          {versions.map((version) => (
            <li key={version.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">rev {version.revisionNumber}{version.label ? ` · ${version.label}` : ""}</span>
                <span className="flex items-center gap-3 text-(length:--text-micro) text-muted-foreground">
                  {chineseTimestamp(version.createdAt)}
                  {version.revisionNumber > 1 ? (
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => openDiff(version)}>对比上一版</button>
                  ) : null}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => setViewRevision(viewRevision?.revisionNumber === version.revisionNumber ? null : version)}
                  >
                    {viewRevision?.revisionNumber === version.revisionNumber ? "收起内容" : "查看"}
                  </button>
                </span>
              </div>
              {viewRevision?.revisionNumber === version.revisionNumber && viewQuery.data ? (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-xs leading-5">{viewQuery.data.content}</pre>
              ) : null}
            </li>
          ))}
          {!versionsQuery.isLoading && versions.length === 0 ? (
            <li className="text-xs text-muted-foreground">还没有快照。CLI 执行 personal-file sync 落第一版。</li>
          ) : null}
        </ul>
      ) : null}
      <RevisionDiffDialog
        open={Boolean(diffRevisions)}
        onOpenChange={(next) => { if (!next) setDiffRevisions(null); }}
        title={`个人文件版本对比 · ${file.path}`}
        revisions={diffRevisions ?? []}
        leftId={selection.leftId}
        rightId={selection.rightId}
        onLeftChange={() => undefined}
        onRightChange={() => undefined}
      />
    </div>
  );
}

export function PersonalFiles() {
  const { selectedCompanyId } = useCompany();
  const filesQuery = useQuery({
    queryKey: ["personal-files", selectedCompanyId],
    queryFn: () => personalFilesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const files = filesQuery.data ?? [];

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">个人指令文件</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          真身在文件系统（库只做登记与快照）；登记与同步走 CLI（personal-file register / sync），回滚=从版本导出后手动覆盖。
        </p>
      </div>
      {filesQuery.isLoading ? <p className="text-xs text-muted-foreground">加载…</p> : null}
      <div className="space-y-3">
        {files.map((file) => (
          <FileCard key={file.id} companyId={selectedCompanyId!} file={file} />
        ))}
      </div>
      {!filesQuery.isLoading && files.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有登记任何个人文件。</p>
      ) : null}
    </div>
  );
}
