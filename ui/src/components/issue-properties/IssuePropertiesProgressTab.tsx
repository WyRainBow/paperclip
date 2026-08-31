import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { AgentIcon, agentCustomIcon } from "@/components/AgentIconPicker";
import { MarkdownBody } from "@/components/MarkdownBody";
import { SystemActorAvatar, SystemNoticeTag } from "@/components/SystemActorAvatar";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { relativeTime } from "@/lib/utils";
import type { Agent, IssueComment } from "@paperclipai/shared";

interface IssuePropertiesProgressTabProps {
  issueId: string;
  companyId: string;
}

export function isProgressNoteComment(comment: IssueComment): boolean {
  return comment.presentation?.kind === "progress_note";
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
  // Human authors show their profile name (e.g. cocoyu), never a bare role
  // word — "board" reading as a fourth participant was the MUL-150 complaint.
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: Boolean(companyId),
  });
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );

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
            // Three actor kinds, three faces (MUL-150): agent → its icon and
            // name; system → the product-glyph avatar named "system" with a
            // 系统通知 tag (platform bookkeeping is nobody's message); human →
            // the profile display name, falling back to the id, never "board".
            const isSystem = (note as { authorType?: string | null }).authorType === "system"
              || (!note.authorAgentId && !note.authorUserId);
            const who = note.authorAgentId
              ? agent?.name ?? "agent"
              : isSystem
                ? "system"
                : (note.authorUserId && userLabelMap.get(note.authorUserId)) || note.authorUserId || "member";
            return (
              <li
                key={note.id}
                className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
              >
                {/* The writer's own icon, same as chat and the discussion bubbles —
                    scanning "who did what, in order" is the whole point of this
                    ledger, and a generic pulse glyph on every row defeats it.
                    System entries carry the product glyph instead of a pulse. */}
                {agent ? (
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    <AgentIcon icon={agent.icon} customIconUrl={agentCustomIcon(agent)} className="h-4 w-4" />
                  </span>
                ) : isSystem ? (
                  <SystemActorAvatar size="xs" className="mt-0.5" />
                ) : (
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-xs font-medium text-foreground">{who}</span>
                      {isSystem ? <SystemNoticeTag /> : null}
                    </span>
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
