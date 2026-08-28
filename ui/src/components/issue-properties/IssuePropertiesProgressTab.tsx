import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { AgentIcon, agentCustomIcon } from "@/components/AgentIconPicker";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { Agent, IssueComment } from "@paperclipai/shared";

interface IssuePropertiesProgressTabProps {
  issueId: string;
  companyId: string;
}

export function isProgressNoteComment(comment: IssueComment): boolean {
  return comment.presentation?.kind === "progress_note";
}

function relativeTime(at: string | Date): string {
  const ms = Date.now() - new Date(at).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * The progress ledger: every `progress_note` comment on the issue, newest
 * first, with the contributing agent's name. Terminal agents file these notes
 * as they work; the chat thread stays conversational, this tab is the ledger.
 */
export function IssuePropertiesProgressTab({ issueId, companyId }: IssuePropertiesProgressTabProps) {
  const { data: comments, isLoading: commentsLoading } = useQuery({
    queryKey: [...queryKeys.issues.comments(issueId), "progress-ledger"],
    queryFn: () => issuesApi.listComments(issueId, { order: "desc", limit: 200 }),
  });
  // Terminated agents keep their notes in the ledger, so their icon has to keep
  // resolving too — otherwise a retired agent's entries lose their face.
  const { data: agents } = useQuery({
    queryKey: [...queryKeys.agents.list(companyId), "with-terminated"],
    queryFn: () => agentsApi.list(companyId, { includeTerminated: true }),
  });

  const notes = (Array.isArray(comments) ? comments : []).filter(isProgressNoteComment);
  const agentById = (id: string | null): Agent | null =>
    (id && (agents ?? []).find((agent) => agent.id === id)) || null;

  return (
    <div className="space-y-2" data-testid="issue-progress-tab">
      {commentsLoading ? (
        <p className="text-xs text-muted-foreground">Loading progress…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No progress notes yet. Agents file them as they work — a comment with
          presentation kind <code>progress_note</code>.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {notes.map((note) => {
            const agent = agentById(note.authorAgentId);
            const who = note.authorAgentId
              ? agent?.name ?? "agent"
              : note.authorUserId ?? "board";
            return (
              <li
                key={note.id}
                className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
              >
                {/* The writer's own icon, same as chat and the discussion bubbles —
                    scanning "who did what, in order" is the whole point of this
                    ledger, and a generic pulse glyph on every row defeats it.
                    Falls back to the pulse for board/user entries. */}
                {agent ? (
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    <AgentIcon icon={agent.icon} customIconUrl={agentCustomIcon(agent)} className="h-4 w-4" />
                  </span>
                ) : (
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">{who}</span>
                    <span className="shrink-0 text-(length:--text-micro) text-muted-foreground" title={new Date(note.createdAt).toLocaleString()}>
                      {relativeTime(note.createdAt)}
                    </span>
                  </div>
                  {/* Rendered as markdown, not pre-wrapped text: a wrap-up note runs
                      to several sections and read as one block it is a wall.
                      softBreaks keeps single newlines meaningful for notes that
                      were written as plain text. */}
                  <MarkdownBody
                    className="mt-0.5 text-sm leading-6 text-foreground/90"
                    softBreaks
                    linkIssueReferences
                  >
                    {note.body}
                  </MarkdownBody>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
