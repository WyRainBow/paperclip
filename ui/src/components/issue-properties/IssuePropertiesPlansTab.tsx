import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { IssuePlanDecompositionsSection } from "@/components/IssuePlanDecompositionsSection";
import { MarkdownBody } from "@/components/MarkdownBody";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { useIssuePlanDocument } from "@/hooks/useIssuePlanDocument";
import { documentDisplayTitle } from "@/lib/issue-artifacts";
import { useLocation } from "@/lib/router";

interface IssuePropertiesPlansTabProps {
  issue: Issue;
  /** Retained for host parity with the other tabs; the Plans tab no longer
   * renders its own approval control (PAP-418). */
  inline?: boolean;
}

function hasPendingPlanConfirmation(interactions: IssueThreadInteraction[] | undefined): boolean {
  return (interactions ?? []).some(
    (interaction) =>
      interaction.kind === "request_confirmation"
      && interaction.status === "pending"
      && interaction.payload.target?.type === "issue_document"
      && interaction.payload.target.key === "plan",
  );
}


/**
 * Plans tab of the properties pane.
 *
 * Owns the plan surface: the `plan` document itself (formerly pinned above
 * the tabs via IssueDocumentsSection, which the chat shell gates off)
 * rendered above the accepted-plan decomposition history. Structured live
 * PlanEntry/todo streaming is a flagged protocol dependency (demonstrated in
 * the /dev/task-chat-lab harness).
 */
export function IssuePropertiesPlansTab({ issue }: IssuePropertiesPlansTabProps) {
  const { data: planDocument, isLoading: planDocumentLoading } = useIssuePlanDocument(issue.id);
  const location = useLocation();
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const { data } = useQuery({
    queryKey: queryKeys.issues.acceptedPlanDecompositions(issue.id),
    queryFn: () => issuesApi.listAcceptedPlanDecompositions(issue.id),
  });
  const { data: interactions } = useQuery({
    queryKey: queryKeys.issues.interactions(issue.id),
    queryFn: () => issuesApi.listInteractions(issue.id),
  });
  const hasPlans = (data?.length ?? 0) > 0;
  const pendingPlanConfirmation = hasPendingPlanConfirmation(interactions);
  // MUL-43: the plan area shows the `plan` document and accepted plan
  // decompositions only. Non-plan documents have no UI surface until that
  // card decides where they live; they stay readable via the CLI/API.
  if (!planDocument && !hasPlans) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        {planDocumentLoading ? (
          "Loading plan…"
        ) : issue.workMode === "planning" ? (
          <div className="space-y-2">
            <p>This task is in plan mode but no plan document has been written yet.</p>
            {pendingPlanConfirmation ? (
              <p className="text-amber-foreground">
                A plan confirmation is pending, but the plan document it should confirm is missing.
              </p>
            ) : null}
          </div>
        ) : (
          "No plan yet. The plan document, accepted plans, and their revisions will appear here."
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      {/* Plan approval lives in ONE place — the plan confirmation card in the
          conversation thread (PAP-418). This tab now only shows the plan itself
          and its accepted-revision history, so there is no second surface to
          approve from. */}
      {planDocument ? (
        <section data-testid="issue-plan-document" className="space-y-2">
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span className="font-mono text-(length:--text-micro)">doc:{planDocument.id?.slice(0, 8) ?? planDocument.key}</span>
            <span>· rev {planDocument.latestRevisionNumber ?? 1}</span>
            {planDocument.createdByAgentId || planDocument.createdByUserId ? (
              <span>· 由 {planDocument.createdByAgentId ? "agent" : planDocument.createdByUserId} 创建</span>
            ) : null}
            <span>· 创建时间 {new Date(planDocument.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span>· 更新时间 {new Date(planDocument.updatedAt).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <DocumentAnnotationsCountChip
              issueId={issue.id}
              docKey="plan"
              panelOpen={annotationPanelOpen}
              onToggle={() => setAnnotationPanelOpen((open) => !open)}
            />
          </div>
          <IssueDocumentAnnotations
            issueId={issue.id}
            doc={{
              key: "plan",
              latestRevisionId: planDocument.latestRevisionId,
              latestRevisionNumber: planDocument.latestRevisionNumber,
            }}
            bodyMarkdown={planDocument.body}
            draftDirty={false}
            draftConflicted={false}
            historicalPreview={false}
            locationHash={location.hash}
            panelOpen={annotationPanelOpen}
            onPanelOpenChange={setAnnotationPanelOpen}
            panelPlacement="popover"
          >
            <MarkdownBody>{planDocument.body}</MarkdownBody>
          </IssueDocumentAnnotations>
        </section>
      ) : null}
      {hasPlans ? (
        <IssuePlanDecompositionsSection issueId={issue.id} issueIdentifier={issue.identifier} />
      ) : null}
    </div>
  );
}
