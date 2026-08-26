import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildLineDiff, type DiffRow } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

/**
 * The minimum a revision must expose to be diffable. Team Rules notes and Team
 * Wiki pages both satisfy it, so the two surfaces share one dialog rather than
 * keeping two copies of the same line-diff rendering in step.
 */
export interface DiffableRevision {
  id: string;
  revisionNumber: number;
  title: string;
  body: string;
  label: string | null;
}

export function revisionLabel(revision: DiffableRevision) {
  return revision.label ? `v${revision.revisionNumber} · ${revision.label}` : `v${revision.revisionNumber}`;
}

/**
 * Pick the pair a "view diff" click should open: the clicked revision on the
 * right, its immediate predecessor on the left. With no target, default to the
 * newest change — the pair a reader almost always wants first.
 */
export function revisionDiffSelection(revisions: DiffableRevision[], targetId?: string | null) {
  const right = targetId ? revisions.find((r) => r.id === targetId) ?? null : revisions[0] ?? null;
  if (!right) return { leftId: null, rightId: null };
  const left = revisions.find((r) => r.revisionNumber < right.revisionNumber) ?? null;
  return { leftId: left?.id ?? null, rightId: right.id };
}

const LINE_CLASS_BY_KIND: Record<DiffRow["kind"], string> = {
  context: "bg-transparent",
  removed: "bg-red-500/10 text-red-900 dark:text-red-100",
  added: "bg-green-500/10 text-green-900 dark:text-green-100",
};

const MARKER_BY_KIND: Record<DiffRow["kind"], string> = {
  context: " ",
  removed: "-",
  added: "+",
};

export function RevisionDiffDialog({
  open,
  onOpenChange,
  title,
  revisions,
  leftId,
  rightId,
  onLeftChange,
  onRightChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog heading, e.g. "差异 · 团队规则". */
  title: string;
  revisions: DiffableRevision[];
  leftId: string | null;
  rightId: string | null;
  onLeftChange: (id: string | null) => void;
  onRightChange: (id: string | null) => void;
}) {
  const left = revisions.find((r) => r.id === leftId) ?? null;
  const right = revisions.find((r) => r.id === rightId) ?? null;
  const diffRows = useMemo(
    () => buildLineDiff(left?.body ?? "", right?.body ?? ""),
    [left?.body, right?.body],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-(--sz-85vh) w-full !max-w-(--pct-90) flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <Badge variant="outline" className="border-red-500/30 bg-red-500/10 uppercase tracking-wider text-red-400">旧</Badge>
              <select
                value={leftId ?? ""}
                onChange={(event) => onLeftChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="">空</option>
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>{revisionLabel(revision)}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <Badge variant="outline" className="border-green-500/30 bg-green-500/10 uppercase tracking-wider text-green-400">新</Badge>
              <select
                value={rightId ?? ""}
                onChange={(event) => onRightChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>{revisionLabel(revision)}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border text-xs">
          {!right ? (
            <div className="p-6 text-center text-sm text-muted-foreground">选一个版本来对比。</div>
          ) : left?.id === right.id ? (
            <div className="p-6 text-center text-sm text-muted-foreground">两边是同一个版本。</div>
          ) : (
            <div className="font-mono text-xs leading-6">
              <div className="grid grid-cols-(--gtc-1) border-b border-border/60 bg-muted/30 px-3 py-2 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                <span>旧</span>
                <span>新</span>
                <span />
                <span>{right.title}</span>
              </div>
              {diffRows.map((row, index) => (
                <div
                  key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                  className={cn("grid grid-cols-(--gtc-1) gap-0 border-b border-border/30 px-3", LINE_CLASS_BY_KIND[row.kind])}
                >
                  <span className="select-none border-r border-border/30 pr-3 text-right text-muted-foreground">{row.oldLineNumber ?? ""}</span>
                  <span className="select-none border-r border-border/30 px-3 text-right text-muted-foreground">{row.newLineNumber ?? ""}</span>
                  <span className="select-none px-3 text-center text-muted-foreground">{MARKER_BY_KIND[row.kind]}</span>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-0 text-inherit">{row.text.length > 0 ? row.text : " "}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
