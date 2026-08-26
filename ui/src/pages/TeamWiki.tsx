import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, History, Pencil, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { useNavigate, useParams } from "@/lib/router";
import { api } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import {
  RevisionDiffDialog,
  revisionDiffSelection,
  revisionLabel,
} from "@/components/RevisionDiffDialog";
import { cn, relativeTime } from "@/lib/utils";

/** Kept in step with the `team_wiki_pages_space_check` constraint. */
const SPACES = ["paperclip", "agent"] as const;
type Space = (typeof SPACES)[number];

const SPACE_META: Record<Space, { label: string; blurb: string }> = {
  paperclip: {
    label: "Paperclip Wiki",
    blurb: "写给人看：Paperclip 自身的文档、架构、排障，以及人要守的约定。可以有背景和取舍过程。",
  },
  agent: {
    label: "Agent Wiki",
    blurb: "写给 Agent 看：可执行的步骤、判定条件、边界、反例。判据是「读完能直接行动」，不是「读着顺」。",
  },
};

interface TeamWikiPage {
  id: string;
  companyId: string;
  space: Space;
  path: string;
  title: string;
  body: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TeamWikiPageVersion {
  id: string;
  pageId: string;
  revisionNumber: number;
  path: string;
  title: string;
  body: string;
  label: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

function pagesKey(companyId: string | null, space: Space, query: string) {
  return ["team-wiki", "pages", companyId, space, query];
}

function versionsKey(companyId: string | null, pageId: string) {
  return ["team-wiki", "pages", companyId, pageId, "versions"];
}

function isSpace(value: string | undefined): value is Space {
  return SPACES.some((space) => space === value);
}

/**
 * Pages store an author id, so resolve names once per company — a reader wants
 * to know which teammate wrote a page, and "agent" alone doesn't answer that.
 */
function useAgentNames(companyId: string | null) {
  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "team-wiki", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data]);
}

function authorLabel(agentId: string | null, agentNames: Map<string, string>) {
  if (!agentId) return null;
  return agentNames.get(agentId) ?? "已移除的 Agent";
}

export function TeamWiki() {
  const params = useParams();
  const navigate = useNavigate();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const agentNames = useAgentNames(selectedCompanyId);

  const space: Space = isSpace(params.space) ? params.space : "paperclip";
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<{ title: string; path: string; body: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const prefix = selectedCompany?.issuePrefix ?? "";
  const query = search.trim();

  const pagesQuery = useQuery({
    queryKey: pagesKey(selectedCompanyId, space, query),
    queryFn: () =>
      api.get<TeamWikiPage[]>(
        `/companies/${selectedCompanyId}/team-wiki/${space}/pages${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      ),
    enabled: Boolean(selectedCompanyId),
  });

  function invalidatePages() {
    queryClient.invalidateQueries({ queryKey: ["team-wiki", "pages", selectedCompanyId, space] });
  }

  const createPage = useMutation({
    mutationFn: (payload: { title: string; path: string; body: string }) =>
      api.post<TeamWikiPage>(`/companies/${selectedCompanyId}/team-wiki/${space}/pages`, payload),
    onSuccess: () => {
      invalidatePages();
      setDraft(null);
    },
    onError: (error: Error) => pushToast({ title: "创建失败", body: error.message, tone: "error" }),
  });

  const updatePage = useMutation({
    mutationFn: (payload: { id: string; title: string; path: string; body: string }) =>
      api.patch<TeamWikiPage>(`/companies/${selectedCompanyId}/team-wiki/${space}/pages/${payload.id}`, {
        title: payload.title,
        path: payload.path,
        body: payload.body,
      }),
    onSuccess: (_data, payload) => {
      invalidatePages();
      queryClient.invalidateQueries({ queryKey: versionsKey(selectedCompanyId, payload.id) });
      setEditing(null);
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  const deletePage = useMutation({
    mutationFn: (id: string) => api.delete(`/companies/${selectedCompanyId}/team-wiki/${space}/pages/${id}`),
    onSuccess: () => invalidatePages(),
  });

  const pages = pagesQuery.data ?? [];
  const meta = SPACE_META[space];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpen className="h-5 w-5 text-sky-600 dark:text-sky-400" aria-hidden /> Team Wiki
        </h1>
        <p className="text-sm text-muted-foreground">
          团队自己写、自己维护的知识。机器蒸馏出来的内容归 LLM Wiki，重建不出来的才放这里。
        </p>
      </header>

      {/* PageTabBar renders Radix triggers, so the change event arrives on the
          surrounding Tabs — wiring only the inner prop leaves the tabs inert. */}
      <Tabs value={space} onValueChange={(next) => navigate(`/${prefix}/team-wiki/${next}`)}>
        <PageTabBar
          align="start"
          value={space}
          onValueChange={(next) => navigate(`/${prefix}/team-wiki/${next}`)}
          items={SPACES.map((value) => ({ value, label: SPACE_META[value].label }))}
        />
      </Tabs>

      <p className="text-sm text-muted-foreground">{meta.blurb}</p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题、正文、路径…"
            aria-label="搜索页面"
            className="pl-8"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDraft({ title: "", path: "", body: "" })}
        >
          新建页面
        </Button>
      </div>

      {draft ? (
        <div className="space-y-2 rounded-lg border border-border p-4">
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="标题"
            aria-label="页面标题"
          />
          <Input
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            placeholder="路径，用斜杠分层，例如 runbooks/deploy。留空则用标题"
            aria-label="页面路径"
            className="font-mono text-xs"
          />
          <Textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="正文（markdown）"
            aria-label="页面正文"
            className="min-h-32"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!draft.title.trim() || createPage.isPending}
              onClick={() => createPage.mutate({ ...draft, path: draft.path.trim() || draft.title.trim() })}
            >
              <Save className="h-4 w-4" aria-hidden /> 保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              <X className="h-4 w-4" aria-hidden /> 取消
            </Button>
          </div>
        </div>
      ) : null}

      {pagesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">加载中…</p>
      ) : pages.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {query
            ? `没有匹配「${query}」的页面。`
            : space === "agent"
              ? "还没有页面。写 Agent 真正会消费的内容：可执行步骤、判定条件、边界、反例。"
              : "还没有页面。写给人看的文档：架构、接口、部署、排障，以及人要守的约定。"}
        </p>
      ) : (
        <ul className="space-y-3">
          {pages.map((page) => (
            <li key={page.id} className="rounded-lg border border-border p-4">
              {editing === page.id ? (
                <PageEditor
                  page={page}
                  onSave={(title, path, body) => updatePage.mutate({ id: page.id, title, path, body })}
                  onCancel={() => setEditing(null)}
                  pending={updatePage.isPending}
                />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-(length:--text-micro) text-muted-foreground">{page.path}</p>
                      <h3 className="text-sm font-semibold">{page.title}</h3>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="版本历史"
                        title="版本历史"
                        onClick={() => setHistoryFor((current) => (current === page.id ? null : page.id))}
                      >
                        <History className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button size="icon-xs" variant="ghost" aria-label="编辑" onClick={() => setEditing(page.id)}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="删除"
                        onClick={() => {
                          if (window.confirm(`删除页面「${page.title}」？版本历史会一并删除。`)) deletePage.mutate(page.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    <MarkdownBody>{page.body || "_（空）_"}</MarkdownBody>
                  </div>
                  <p className="mt-2 text-(length:--text-micro) text-muted-foreground">
                    更新于 {new Date(page.updatedAt).toLocaleString()}
                    {authorLabel(page.createdByAgentId, agentNames)
                      ? ` · ${authorLabel(page.createdByAgentId, agentNames)} 创建`
                      : ""}
                  </p>
                  {historyFor === page.id ? (
                    <PageVersions
                      companyId={selectedCompanyId}
                      space={space}
                      pageId={page.id}
                      agentNames={agentNames}
                      onRestored={invalidatePages}
                    />
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PageVersions({
  companyId,
  space,
  pageId,
  agentNames,
  onRestored,
}: {
  companyId: string | null;
  space: Space;
  pageId: string;
  agentNames: Map<string, string>;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [diffOpen, setDiffOpen] = useState(false);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: versionsKey(companyId, pageId),
    queryFn: () =>
      api.get<TeamWikiPageVersion[]>(`/companies/${companyId}/team-wiki/${space}/pages/${pageId}/versions`),
    enabled: Boolean(companyId),
  });

  const restore = useMutation({
    mutationFn: (revisionNumber: number) =>
      api.post(`/companies/${companyId}/team-wiki/${space}/pages/${pageId}/versions/${revisionNumber}/restore`, {}),
    onSuccess: () => {
      onRestored();
      queryClient.invalidateQueries({ queryKey: versionsKey(companyId, pageId) });
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
        <Button type="button" variant="outline" size="sm" onClick={() => openDiff()} disabled={versions.length < 2}>
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
                <div className={cn("mt-0.5 text-(length:--text-micro) text-muted-foreground")}>
                  {relativeTime(version.createdAt)}
                  {authorLabel(version.authorAgentId, agentNames)
                    ? ` · ${authorLabel(version.authorAgentId, agentNames)}`
                    : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* The newest revision already is the live page, so restoring it
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
                      if (window.confirm(`把这个页面回滚到 v${version.revisionNumber}？当前内容会另存为新版本。`)) {
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
        title="差异 · Team Wiki"
        revisions={versions}
        leftId={leftId}
        rightId={rightId}
        onLeftChange={setLeftId}
        onRightChange={setRightId}
      />
    </div>
  );
}

function PageEditor({
  page,
  onSave,
  onCancel,
  pending,
}: {
  page: TeamWikiPage;
  onSave: (title: string, path: string, body: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState(page.title);
  const [path, setPath] = useState(page.path);
  const [body, setBody] = useState(page.body);
  return (
    <div className="space-y-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="页面标题" />
      <Input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="页面路径"
        className="font-mono text-xs"
      />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="页面正文" className="min-h-32" />
      <div className="flex gap-2">
        <Button size="sm" disabled={!title.trim() || !path.trim() || pending} onClick={() => onSave(title, path, body)}>
          <Save className="h-4 w-4" aria-hidden /> 保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-4 w-4" aria-hidden /> 取消
        </Button>
      </div>
    </div>
  );
}
