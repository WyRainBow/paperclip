import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { issuesApi } from "@/api/issues";
import { cn, chineseTimestamp } from "@/lib/utils";
import { AgentIcon, agentCustomIcon } from "@/components/AgentIconPicker";
import { FileText } from "lucide-react";
import { buildDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";

const AGENT_BRAND_COLORS: Record<string, string> = {
  "Claude（Terminal）": "#D97757",
  "Codex（Terminal）": "#10A37F",
  "Codex Review": "#10A37F",
  "Zcode（Terminal）": "#2563eb",
  "Grok": "#6366f1",
  "Grok（Terminal）": "#6366f1",
};
import { agentsApi } from "@/api/agents";
import type { Agent } from "@paperclipai/shared";
import { useMemo } from "react";

interface DiscussionComment {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
  presentation?: {
    kind?: string;
    threadId?: string;
    role?: string;
    label?: string | null;
    answerAgent?: string;
    answerAgentId?: string;
    questionAgentId?: string;
    docKey?: string;
    docTitle?: string;
  } | null;
}

interface Thread {
  threadId: string;
  label: string | null;
  question: DiscussionComment | null;
  answer: DiscussionComment | null;
  createdAt: string;
}

/**
 * Discussion tab: Q&A pairs as chat bubbles. The sides follow the review
 * roles, not the question/answer roles (MUL-51): the side that commissioned
 * the review (the question) sits right, the responding agent (the answer)
 * sits left, so a Claude→Codex/Grok review reads like one conversation.
 * Threads are comments linked by presentation.threadId with
 * kind=discussion_qa (MUL-38: zero new tables, same mechanism as
 * progress_note).
 */
export function IssueDiscussionPanel({ issueId, issueIdentifier }: { issueId: string; issueIdentifier?: string | null }) {
  const { selectedCompanyId } = useCompany();
  const commentsQuery = useQuery({
    queryKey: ["issues", issueId, "discussion"],
    queryFn: () => issuesApi.listComments(issueId, { order: "asc", limit: 200 }),
    enabled: Boolean(issueId),
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", selectedCompanyId, "with-terminated"],
    queryFn: () => agentsApi.list(selectedCompanyId!, { includeTerminated: true }),
    enabled: Boolean(selectedCompanyId),
  });
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);

  // Older answers carry only presentation.answerAgent (a name string), so the
  // agent record — and with it the provider logo — has to be found by name.
  const agentByName = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.name, agent);
    return map;
  }, [agentsQuery.data]);

  const comments = (Array.isArray(commentsQuery.data) ? commentsQuery.data : []) as unknown as DiscussionComment[];
  const threadsMap = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const c of comments) {
      const p = c.presentation;
      if (p?.kind !== "discussion_qa" || !p.threadId) continue;
      const thread = map.get(p.threadId) ?? {
        threadId: p.threadId,
        label: p.label ?? null,
        question: null,
        answer: null,
        createdAt: c.createdAt,
      };
      if (p.role === "question") thread.question = c;
      if (p.role === "answer") thread.answer = c;
      map.set(p.threadId, thread);
    }
    return map;
  }, [comments]);

  const threads = [...threadsMap.values()].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (commentsQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">加载讨论…</p>;
  }

  if (threads.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        还没有讨论线程。CLI 执行 paperclipai issue qa &lt;卡号&gt; --question "…" --answer "…" 落第一对。
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="issue-discussion-panel">
      {threads.map((thread) => (
        <div key={thread.threadId} className="space-y-2 rounded-lg border border-border/60 p-3" data-testid="discussion-thread">
          {thread.label ? (
            <p className="text-(length:--text-micro) font-medium text-muted-foreground">{thread.label}</p>
          ) : null}
          {(["question", "answer"] as const).map((role) => {
            const msg = thread[role];
            if (!msg) return null;
            const answerAgentName = msg.presentation?.answerAgent ?? null;
            // Both sides can be filed on behalf, so each carries its own
            // attributed agent id; authorAgentId is only the writer.
            const attributedAgentId = msg.presentation?.answerAgentId ?? msg.presentation?.questionAgentId ?? null;
            const isAgent = Boolean(msg.authorAgentId) || Boolean(answerAgentName) || Boolean(attributedAgentId);
            const agent = (attributedAgentId ? agentMap.get(attributedAgentId) : null)
              ?? (msg.authorAgentId ? agentMap.get(msg.authorAgentId) : null)
              ?? (answerAgentName ? agentByName.get(answerAgentName) : null)
              ?? null;
            const displayName = agent?.name ?? answerAgentName ?? msg.authorUserId ?? "board";
            return (
              <div
                key={msg.id}
                className={cn("flex gap-2", role === "question" ? "justify-end" : "justify-start")}
                data-testid={`bubble-${role}`}
              >
                {role === "question" ? null : (
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-sky-500/30 bg-sky-500/10 text-(length:--text-micro) font-medium text-sky-700 dark:text-sky-300"
                    title={isAgent ? displayName : undefined}
                  >
                    {agent ? (
                      <AgentIcon icon={agent.icon} customIconUrl={agentCustomIcon(agent)} className="h-4 w-4" />
                    ) : (
                      "A"
                    )}
                  </span>
                )}
                <div
                  className={cn(
                    "max-w-[80%] rounded-xl px-3 py-2 text-sm leading-5",
                    role === "question"
                      ? "rounded-br-sm bg-muted/50 text-foreground"
                      : "rounded-bl-sm border border-sky-500/20 bg-sky-500/5 text-foreground",
                  )}
                >
                  <p className="mb-0.5 flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
                    {isAgent && agent ? (
                      <>
                        <AgentIcon icon={agent.icon} customIconUrl={agentCustomIcon(agent)} className="h-3 w-3" />
                        {agent.name}
                        {AGENT_BRAND_COLORS[agent.name] ? (
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: AGENT_BRAND_COLORS[agent.name] }} aria-label={agent.name} />
                        ) : null}
                      </>
                    ) : isAgent && answerAgentName ? (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: AGENT_BRAND_COLORS[answerAgentName] ?? "#64748b" }} aria-hidden />
                        {answerAgentName}
                      </>
                    ) : (
                      displayName
                    )}
                    <span>· {chineseTimestamp(msg.createdAt)}</span>
                  </p>
                  <p className="whitespace-pre-wrap">{msg.body}</p>
                  {msg.presentation?.docKey ? (
                    <a
                      href={`${createIssueDetailPath(issueIdentifier ?? issueId)}${buildDocumentAnnotationHash({ documentKey: msg.presentation.docKey, threadId: null, commentId: null })}`}
                      className="mt-1.5 inline-flex items-center gap-1 text-(length:--text-micro) font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
                    >
                      <FileText className="h-3 w-3" aria-hidden />
                      {msg.presentation.docTitle ?? `完整评审：${msg.presentation.docKey}`}
                    </a>
                  ) : null}
                </div>
                {role === "answer" ? null : (
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted/40 text-(length:--text-micro) font-medium text-muted-foreground"
                    title={isAgent ? displayName : undefined}
                  >
                    {agent ? (
                      <AgentIcon icon={agent.icon} customIconUrl={agentCustomIcon(agent)} className="h-4 w-4" />
                    ) : (
                      "Q"
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
