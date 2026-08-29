/**
 * Live adapter: normalize the existing IssueChatComment stream (including
 * optimistic echoes) into the redesign's TaskChatItem[] model. This is the
 * seam that lets the new render layer show live task data without touching the
 * comment data pipeline. Rich agent-run streaming (thinking/tool/diff) is
 * demonstrated in the harness and layered onto this adapter as a later step;
 * the baseline live thread renders the author-typed message history + optimistic
 * echo, which is the core legibility win.
 */
import type { Agent } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { resolveCommentAttribution } from "@/lib/comment-attribution";
import { agentCustomIcon } from "@/components/AgentIconPicker";
import { isDecisionEffectComment } from "@/lib/decision-effect";
import type { TaskChatAuthorKind, TaskChatItem } from "./task-chat-model";

export interface TaskChatAdapterContext {
  agentMap?: Map<string, Agent>;
  userLabelMap?: ReadonlyMap<string, string> | null;
  currentUserId?: string | null;
  /**
   * Task's current assignee. Agent comments from anyone else are cross-issue
   * writes and get a "for {user}" attribution chip (the open cross-task write design (attribution)).
   */
  issueAssigneeAgentId?: string | null;
}

function effectiveAgentId(comment: IssueChatComment): string | null {
  return comment.authorAgentId ?? comment.derivedAuthorAgentId ?? null;
}

function authorKind(comment: IssueChatComment): TaskChatAuthorKind {
  // System authorship wins over any derivable run→agent linkage (PAP-443):
  // recovery notices carry a derivedAuthorAgentId but must not render as
  // agent bubbles.
  if (comment.authorType === "system") return "system";
  if (effectiveAgentId(comment)) return "agent";
  if (comment.authorType === "user") return "human";
  return "agent";
}

/** Shared bubble-footer time format ("2:34 PM") — also used by the description bubble (PAP-375). */
export function formatTaskChatTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Whether a comment becomes a chat item at all. Deleted comments are gone,
 * progress notes live in the Progress tab only, and discussion QA threads
 * live in the Discussion tab only (four-surface split, user 2026-08-26/28).
 *
 * Exported because callers that pair items back to their source comments must
 * filter with the *same* predicate. Re-stating it by hand is what broke the
 * thread's chronology in MUL-120: the shorter item list was indexed against a
 * longer comment list, so every bubble inherited a neighbour's sort key.
 */
export function isTaskChatRenderableComment(comment: IssueChatComment): boolean {
  if (comment.deletedAt) return false;
  const presentation = comment.presentation as { kind?: string } | null | undefined;
  if (presentation?.kind === "progress_note") return false;
  if (presentation?.kind === "discussion_qa") return false;
  return true;
}

export function commentsToTaskChatItems(
  comments: IssueChatComment[],
  ctx: TaskChatAdapterContext = {},
): TaskChatItem[] {
  const items: TaskChatItem[] = [];
  for (const comment of comments) {
    if (!isTaskChatRenderableComment(comment)) continue;
    const kind = authorKind(comment);
    let authorName: string | undefined;
    let agentIcon: string | null | undefined;
    let agentCustomIconUrl: string | null | undefined;
    let onBehalfOfUserName: string | undefined;
    if (kind === "agent") {
      const agentId = effectiveAgentId(comment);
      const agent = agentId ? ctx.agentMap?.get(agentId) : undefined;
      authorName = agent?.name || "Agent";
      agentIcon = agent?.icon;
      // The official brand mark (metadata.customIcon) wins over the lucide
      // name — without threading it through, chat bubbles kept showing the
      // initials fallback while every other surface showed the logo (MUL-152).
      agentCustomIconUrl = agentCustomIcon(agent);
      onBehalfOfUserName = resolveCommentAttribution({
        authorAgentId: agentId,
        onBehalfOfUserId: comment.onBehalfOfUserId ?? null,
        issueAssigneeAgentId: ctx.issueAssigneeAgentId,
        resolveUserLabel: (userId) => ctx.userLabelMap?.get(userId),
      })?.userName;
    } else if (kind === "human") {
      authorName =
        (comment.authorUserId && ctx.userLabelMap?.get(comment.authorUserId)) || undefined;
    }
    const queued = comment.queueState === "queued" || comment.clientStatus === "queued";
    const optimistic =
      queued
        ? "queued"
        : comment.clientStatus === "pending"
          ? "pending"
          : undefined;
    const createdAtIso =
      comment.createdAt instanceof Date
        ? comment.createdAt.toISOString()
        : comment.createdAt
          ? String(comment.createdAt)
          : undefined;
    items.push({
      id: comment.id || comment.clientId || `${comment.createdAt}`,
      kind: "message",
      author: kind,
      authorName,
      text: comment.body,
      timestamp: formatTaskChatTimestamp(comment.createdAt),
      optimistic,
      queueTargetRunId: queued ? comment.queueTargetRunId ?? null : null,
      agentIcon,
      agentCustomIconUrl,
      isDecisionEffect: kind === "agent" ? isDecisionEffectComment(comment) : undefined,
      onBehalfOfUserName,
      // System notices carry their structured hints through to the render
      // layer (PAP-443); other authors keep the item lean.
      presentation: kind === "system" ? comment.presentation ?? null : undefined,
      metadata: kind === "system" ? comment.metadata ?? null : undefined,
      runAgentId: kind === "system" ? comment.runAgentId ?? null : undefined,
      createdAtIso: kind === "system" ? createdAtIso : undefined,
    });
  }
  return items;
}
