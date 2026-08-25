import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Globe, Plug, Puzzle, Save, Trash2, X } from "lucide-react";
import { api } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";

interface OpenspaceNote {
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

interface CompanySkillRow {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  sourceType: string;
}

/** Skill origin buckets for the reference section (MUL-16 §5). */
function skillOrigin(skill: CompanySkillRow): "openspace" | "plugin" | "company" {
  if (skill.key.startsWith("plugin/")) return "plugin";
  if (skill.key.startsWith("company/")) return "openspace";
  return "company";
}

export function Openspace() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const notesQuery = useQuery({
    queryKey: ["openspace", "notes", selectedCompanyId],
    queryFn: () => api.get<OpenspaceNote[]>(`/companies/${selectedCompanyId}/openspace/notes`),
    enabled: Boolean(selectedCompanyId),
  });
  const skillsQuery = useQuery({
    queryKey: ["company-skills", "list", selectedCompanyId ?? ""],
    queryFn: () => api.get<CompanySkillRow[]>(`/companies/${selectedCompanyId}/skills`),
    enabled: Boolean(selectedCompanyId),
  });

  const createNote = useMutation({
    mutationFn: (payload: { title: string; body: string }) =>
      api.post<OpenspaceNote>(`/companies/${selectedCompanyId}/openspace/notes`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openspace", "notes", selectedCompanyId] });
      setDraft(null);
    },
    onError: (error: Error) => pushToast({ title: "创建失败", body: error.message, tone: "error" }),
  });
  const updateNote = useMutation({
    mutationFn: (payload: { id: string; title: string; body: string }) =>
      api.patch<OpenspaceNote>(`/companies/${selectedCompanyId}/openspace/notes/${payload.id}`, {
        title: payload.title,
        body: payload.body,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openspace", "notes", selectedCompanyId] });
      setEditing(null);
    },
  });
  const deleteNote = useMutation({
    mutationFn: (id: string) => api.delete(`/companies/${selectedCompanyId}/openspace/notes/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["openspace", "notes", selectedCompanyId] }),
  });

  const notes = notesQuery.data ?? [];
  const skills = skillsQuery.data ?? [];
  const groups = {
    openspace: skills.filter((s) => skillOrigin(s) === "openspace"),
    plugin: skills.filter((s) => skillOrigin(s) === "plugin"),
    company: skills.filter((s) => skillOrigin(s) === "company"),
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-6 py-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Globe className="h-5 w-5 text-sky-600 dark:text-sky-400" aria-hidden /> Openspace
        </h1>
        <p className="text-sm text-muted-foreground">
          公司级共享上下文：公共笔记 + 对技能与 wiki 的引用（不复制、不动现有 Tab）。
        </p>
      </header>

      {/* 公共笔记 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">公共笔记</h2>
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
          <p className="text-xs text-muted-foreground">还没有公共笔记。放一些团队约定、常用指针、公共说明。</p>
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
                        <Button size="icon-xs" variant="ghost" aria-label="编辑" onClick={() => setEditing(note.id)}>
                          <Puzzle className="h-3.5 w-3.5" aria-hidden />
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
                      {note.createdByAgentId ? " · agent 创建" : ""}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 技能引用（按来源分组，MUL-16 §5） */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">技能引用（按来源）</h2>
        <p className="text-xs text-muted-foreground">
          只读引用：openspace 自建 / plugin 带入 / 其他公司库来源。管理与安装仍在 Skills 页。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {(
            [
              ["openspace", "Openspace 自建", Boxes, groups.openspace],
              ["plugin", "Plugin 带入", Plug, groups.plugin],
              ["company", "公司库其他", Globe, groups.company],
            ] as const
          ).map(([kind, label, Icon, list]) => (
            <div key={kind} className="rounded-lg border border-border p-3">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {label}
                <span className="ml-auto text-muted-foreground">{list.length}</span>
              </h3>
              <ul className="mt-2 space-y-1">
                {list.length === 0 ? (
                  <li className="text-(length:--text-micro) text-muted-foreground">无</li>
                ) : (
                  list.slice(0, 8).map((s) => (
                    <li key={s.id} className="truncate text-xs" title={s.name + (s.description ? ` — ${s.description}` : "")}>
                      · {s.name}
                    </li>
                  ))
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* wiki 引用（软链） */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Wiki 引用</h2>
        <p className="text-xs text-muted-foreground">
          LLM Wiki（个人知识库机制）当前{skills.some((s) => s.key.includes("llm-wiki")) ? "已随插件提供技能入口" : "未安装插件"}；
          安装 plugin-llm-wiki 后此处与 Wiki 页互通，内容不复制只引用。
        </p>
      </section>
    </div>
  );
}

function NoteEditor({
  note,
  onSave,
  onCancel,
  pending,
}: {
  note: OpenspaceNote;
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
