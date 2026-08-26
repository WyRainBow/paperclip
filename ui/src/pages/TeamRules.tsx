import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Pencil, RotateCcw, Save, Scale, Trash2, X } from "lucide-react";
import { api } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  RevisionDiffDialog,
  revisionDiffSelection,
  revisionLabel,
} from "@/components/RevisionDiffDialog";
import { relativeTime } from "@/lib/utils";

interface TeamRuleNote {
  id: string;
  companyId: string;
  title: string;
  body: string;
  position: number;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TeamRuleNoteVersion {
  id: string;
  noteId: string;
  revisionNumber: number;
  title: string;
  body: string;
  label: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

function notesKey(companyId: string | null) {
  return ["team-rules", "notes", companyId];
}

function versionsKey(companyId: string | null, noteId: string) {
  return ["team-rules", "notes", companyId, noteId, "versions"];
}

/**
 * Notes and versions only store an agent id, so resolve names once per company
 * and hand the map down — a rule reader wants to know *which* teammate wrote a
 * revision, and "agent" alone doesn't answer that.
 */
function useAgentNames(companyId: string | null) {
  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "team-rules", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data]);
}

/**
 * Byline for a note or revision. An id with no matching agent means the author
 * has since been removed from the company — say so rather than falling back to
 * a bare "agent", which reads as if we simply didn't bother to look it up.
 */
function authorLabel(agentId: string | null, agentNames: Map<string, string>) {
  if (!agentId) return null;
  return agentNames.get(agentId) ?? "已移除的 Agent";
}

export function TeamRules() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const agentNames = useAgentNames(selectedCompanyId);

  const notesQuery = useQuery({
    queryKey: notesKey(selectedCompanyId),
    queryFn: () => api.get<TeamRuleNote[]>(`/companies/${selectedCompanyId}/team-rules/notes`),
    enabled: Boolean(selectedCompanyId),
  });

  const createNote = useMutation({
    mutationFn: (payload: { title: string; body: string }) =>
      api.post<TeamRuleNote>(`/companies/${selectedCompanyId}/team-rules/notes`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notesKey(selectedCompanyId) });
      setDraft(null);
    },
    onError: (error: Error) => pushToast({ title: "创建失败", body: error.message, tone: "error" }),
  });
  const updateNote = useMutation({
    mutationFn: (payload: { id: string; title: string; body: string }) =>
      api.patch<TeamRuleNote>(`/companies/${selectedCompanyId}/team-rules/notes/${payload.id}`, {
        title: payload.title,
        body: payload.body,
      }),
    onSuccess: (_data, payload) => {
      queryClient.invalidateQueries({ queryKey: notesKey(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: versionsKey(selectedCompanyId, payload.id) });
      setEditing(null);
    },
  });
  const deleteNote = useMutation({
    mutationFn: (id: string) => api.delete(`/companies/${selectedCompanyId}/team-rules/notes/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notesKey(selectedCompanyId) }),
  });

  const notes = notesQuery.data ?? [];
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-6 py-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Scale className="h-5 w-5 text-sky-600 dark:text-sky-400" aria-hidden /> Team Rules
        </h1>
        <p className="text-sm text-muted-foreground">
          全局团队规则（Team Rules）：所有 agent 与人共守的唯一规则正文，规则优先级最高层——Team Rules ＞ terminal-workflow skill（操作 SOP）＞ 各 agent 自有 AGENTS.md（个体补充）。
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Rules</h2>
          <Button size="sm" variant="outline" onClick={() => setDraft({ title: "", body: "" })}>
            新建笔记
          </Button>
        </div>
        {draft ? (
          <div className="space-y-2 rounded-lg border border-border p-4">
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="标题"
              aria-label="笔记标题"
            />
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="正文（markdown）"
              aria-label="笔记正文"
              className="min-h-32"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!draft.title.trim() || createNote.isPending}
                onClick={() => createNote.mutate(draft)}
              >
                <Save className="h-4 w-4" aria-hidden /> 保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                <X className="h-4 w-4" aria-hidden /> 取消
              </Button>
            </div>
          </div>
        ) : null}
        {notesQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : notes.length === 0 && !draft ? (
          <p className="text-xs text-muted-foreground">还没有规则。写全局团队规则：身份与通道、接卡流程、决策与记录、纪律。</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((note) => (
              <li key={note.id} className="rounded-lg border border-border p-4">
                {editing === note.id ? (
                  <NoteEditor
                    note={note}
                    onSave={(title, body) => updateNote.mutate({ id: note.id, title, body })}
                    onCancel={() => setEditing(null)}
                    pending={updateNote.isPending}
                  />
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold">{note.title}</h3>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="版本历史"
                          title="版本历史"
                          onClick={() => setHistoryFor((current) => (current === note.id ? null : note.id))}
                        >
                          <History className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label="编辑" onClick={() => setEditing(note.id)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="删除"
                          onClick={() => {
                            if (window.confirm(`删除笔记「${note.title}」？`)) deleteNote.mutate(note.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      <MarkdownBody>{note.body || "_（空）_"}</MarkdownBody>
                    </div>
                    <p className="mt-2 text-(length:--text-micro) text-muted-foreground">
                      更新于 {new Date(note.updatedAt).toLocaleString()}
                      {authorLabel(note.createdByAgentId, agentNames)
                        ? ` · ${authorLabel(note.createdByAgentId, agentNames)} 创建`
                        : ""}
                    </p>
                    {historyFor === note.id ? (
                      <NoteVersions
                        companyId={selectedCompanyId}
                        noteId={note.id}
                        agentNames={agentNames}
                      />
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NoteVersions({
  companyId,
  noteId,
  agentNames,
}: {
  companyId: string | null;
  noteId: string;
  agentNames: Map<string, string>;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [diffOpen, setDiffOpen] = useState(false);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: versionsKey(companyId, noteId),
    queryFn: () =>
      api.get<TeamRuleNoteVersion[]>(`/companies/${companyId}/team-rules/notes/${noteId}/versions`),
    enabled: Boolean(companyId),
  });

  const restore = useMutation({
    mutationFn: (revisionNumber: number) =>
      api.post(`/companies/${companyId}/team-rules/notes/${noteId}/versions/${revisionNumber}/restore`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notesKey(companyId) });
      queryClient.invalidateQueries({ queryKey: versionsKey(companyId, noteId) });
    },
    onError: (error: Error) => pushToast({ title: "回滚失败", body: error.message, tone: "error" }),
  });

  // The API already returns newest-first; sorting here keeps the component
  // correct if that ever changes, since every index below assumes it.
  const versions = useMemo(
    () => [...(versionsQuery.data ?? [])].sort((a, b) => b.revisionNumber - a.revisionNumber),
    [versionsQuery.data],
  );

  function openDiff(targetId?: string) {
    const selection = revisionDiffSelection(versions, targetId);
    setLeftId(selection.leftId);
    setRightId(selection.rightId);
    setDiffOpen(true);
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {versionsQuery.isLoading ? "加载版本…" : `${versions.length} 个版本`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openDiff()}
          disabled={versions.length < 2}
        >
          <History className="mr-1.5 h-3.5 w-3.5" aria-hidden /> 对比
        </Button>
      </div>
      <div className="mt-2 border-t border-border">
        {versions.length === 0 && !versionsQuery.isLoading ? (
          <p className="py-4 text-xs text-muted-foreground">还没有保存过版本。</p>
        ) : (
          versions.map((version, index) => (
            <div
              key={version.id}
              className="flex items-center justify-between gap-2 border-b border-border py-2.5 text-sm last:border-b-0"
            >
              <div className="min-w-0">
                <div className="text-xs font-medium">
                  {revisionLabel(version)}
                  {index === 0 ? <span className="ml-2 text-muted-foreground">当前</span> : null}
                </div>
                <div className="mt-0.5 text-(length:--text-micro) text-muted-foreground">
                  {relativeTime(version.createdAt)}
                  {authorLabel(version.authorAgentId, agentNames)
                    ? ` · ${authorLabel(version.authorAgentId, agentNames)}`
                    : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* The newest revision already is the live text, so restoring it
                    would only append an identical version. */}
                {index === 0 ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`回滚到 v${version.revisionNumber}`}
                    title={`回滚到 v${version.revisionNumber}`}
                    disabled={restore.isPending}
                    onClick={() => {
                      if (window.confirm(`把这条规则回滚到 v${version.revisionNumber}？当前内容会另存为新版本。`)) {
                        restore.mutate(version.revisionNumber);
                      }
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={versions.length < 2}
                  onClick={() => openDiff(version.id)}
                >
                  查看差异
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
      <RevisionDiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="差异 · 团队规则"
        revisions={versions}
        leftId={leftId}
        rightId={rightId}
        onLeftChange={setLeftId}
        onRightChange={setRightId}
      />
    </div>
  );
}

function NoteEditor({
  note,
  onSave,
  onCancel,
  pending,
}: {
  note: TeamRuleNote;
  onSave: (title: string, body: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  return (
    <div className="space-y-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="笔记标题" />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="笔记正文" className="min-h-32" />
      <div className="flex gap-2">
        <Button size="sm" disabled={!title.trim() || pending} onClick={() => onSave(title, body)}>
          <Save className="h-4 w-4" aria-hidden /> 保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-4 w-4" aria-hidden /> 取消
        </Button>
      </div>
    </div>
  );
}
