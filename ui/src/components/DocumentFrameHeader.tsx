import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentIcon } from "./AgentIconPicker";
import { deriveInitials } from "./Identity";

export type DocumentFrameHeaderRevisionActor = {
  kind: "agent" | "user" | "system";
  name: string;
  agentIcon?: string | null;
  /** Provider logo (metadata.customIcon); the lucide icon is the fallback. */
  agentIconUrl?: string | null;
  imageUrl?: string | null;
};

export type DocumentFrameHeaderRevision = {
  id: string;
  revisionNumber: number;
  createdAt: string | Date;
  actor: DocumentFrameHeaderRevisionActor;
};

export type DocumentFrameHeaderRevisionMenu = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  revisions: DocumentFrameHeaderRevision[];
  selectedRevisionId: string | null;
  currentRevisionId: string | null;
  displayedRevisionNumber: number;
  historicalPreview: boolean;
  onSelectRevision: (revisionId: string, isCurrentRevision: boolean) => void;
};

export interface DocumentFrameHeaderProps {
  documentKey: string;
  /** Document title — the primary scan anchor, rendered as the first line. */
  documentLabel?: string;
  folded: boolean;
  onToggleFolded: () => void;
  revisionMenu?: DocumentFrameHeaderRevisionMenu;
  updatedAt?: string | Date | null;
  updatedHref?: string;
  /** The handle the CLI addresses this document by. Kept out of the folded
      row (MUL-177): it renders in the meta line only while unfolded, as a
      click-to-copy chip. */
  documentId?: string | null;
  /** Who filed it. Avatar only in the meta line; the name lives in the
      hover title (MUL-177). */
  createdBy?: DocumentFrameHeaderRevisionActor | null;
  sourceTrustSlot?: ReactNode;
  annotationSlot?: ReactNode;
  actionsSlot?: ReactNode;
}

function RevisionActorAvatar({ actor }: { actor: DocumentFrameHeaderRevisionActor }) {
  return (
    <Avatar size="xs" shape={actor.kind === "agent" ? "square" : "circle"} className="shrink-0">
      {actor.kind === "agent" ? (
        <AvatarFallback>
          <AgentIcon icon={actor.agentIcon} customIconUrl={actor.agentIconUrl} className="h-3 w-3" />
        </AvatarFallback>
      ) : (
        <>
          {actor.imageUrl ? <AvatarImage src={actor.imageUrl} alt={actor.name} /> : null}
          <AvatarFallback>{deriveInitials(actor.name)}</AvatarFallback>
        </>
      )}
    </Avatar>
  );
}

function DocumentKeyBadge({ documentKey }: { documentKey: string }) {
  return (
    <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
      {documentKey}
    </Badge>
  );
}

export function DocumentFrameHeader({
  documentKey,
  documentLabel,
  folded,
  onToggleFolded,
  revisionMenu,
  updatedAt,
  updatedHref,
  documentId,
  createdBy,
  sourceTrustSlot,
  annotationSlot,
  actionsSlot,
}: DocumentFrameHeaderProps) {
  const [copiedDocumentId, setCopiedDocumentId] = useState(false);
  const copyDocumentId = () => {
    if (!documentId) return;
    void navigator.clipboard?.writeText(documentId).then(() => {
      setCopiedDocumentId(true);
      window.setTimeout(() => setCopiedDocumentId(false), 1500);
    });
  };

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {/* Primary line: the title is the scan anchor (MUL-177). Documents
            without a display title lead with the key badge instead. */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={onToggleFolded}
            aria-label={folded ? `Expand ${documentKey} document` : `Collapse ${documentKey} document`}
            aria-expanded={!folded}
          >
            {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {documentLabel ? (
            <span className="truncate text-sm font-medium text-foreground">{documentLabel}</span>
          ) : (
            <DocumentKeyBadge documentKey={documentKey} />
          )}
        </div>
        {/* Meta line, indented under the title. Labels are gone: the avatar
            carries the author (name on hover) and the bare relative time
            carries freshness (MUL-177). */}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-7">
          {documentLabel ? <DocumentKeyBadge documentKey={documentKey} /> : null}
          {sourceTrustSlot}
          {revisionMenu ? (
            <DropdownMenu open={revisionMenu.open} onOpenChange={revisionMenu.onOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-auto px-1.5 py-0 text-(length:--text-micro) font-normal text-muted-foreground hover:text-foreground",
                    revisionMenu.historicalPreview && "text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200",
                  )}
                >
                  revision {revisionMenu.displayedRevisionNumber}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel>Revision history</DropdownMenuLabel>
                {revisionMenu.loading && revisionMenu.revisions.length === 0 ? (
                  <DropdownMenuItem disabled>Loading revisions...</DropdownMenuItem>
                ) : revisionMenu.revisions.length > 0 ? (
                  <DropdownMenuRadioGroup value={revisionMenu.selectedRevisionId ?? revisionMenu.currentRevisionId ?? ""}>
                    {revisionMenu.revisions.map((revision) => {
                      const isCurrentRevision = revision.id === revisionMenu.currentRevisionId;
                      return (
                        <DropdownMenuRadioItem
                          key={revision.id}
                          value={revision.id}
                          onSelect={() => revisionMenu.onSelectRevision(revision.id, isCurrentRevision)}
                          className="items-start"
                        >
                          <div className="flex min-w-0 flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">revision {revision.revisionNumber}</span>
                              {isCurrentRevision ? (
                                <Badge variant="outline" className="border-border px-1.5 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                                  Current
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
                              <RevisionActorAvatar actor={revision.actor} />
                              <span className="truncate">
                                {relativeTime(revision.createdAt)} • {revision.actor.name}
                              </span>
                            </div>
                          </div>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                ) : (
                  <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {createdBy ? (
            <span
              className="inline-flex shrink-0 items-center"
              title={`创建人：${createdBy.name}`}
            >
              <RevisionActorAvatar actor={createdBy} />
            </span>
          ) : null}
          {updatedAt ? (
            <a
              href={updatedHref ?? `#document-${encodeURIComponent(documentKey)}`}
              title={`更新时间：${relativeTime(updatedAt)}`}
              className="truncate text-(length:--text-micro) text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              {relativeTime(updatedAt)}
            </a>
          ) : null}
          {!folded && documentId ? (
            // Multica-style id chip: the muted block says "identifier", so the
            // value needs no "docID:" prefix. Hover reveals the full UUID,
            // click copies it. Same recipe as the session-id box in the
            // properties pane (issue-properties/primitives.tsx).
            <button
              type="button"
              onClick={copyDocumentId}
              title={copiedDocumentId ? "已复制" : `复制 docID：${documentId}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-muted/40 px-1.5 font-mono text-(length:--text-micro) text-muted-foreground transition-colors hover:text-foreground"
            >
              {documentId.slice(0, 8)}
              {copiedDocumentId ? <Check className="h-3 w-3" /> : null}
            </button>
          ) : null}
          {annotationSlot}
        </div>
      </div>
      {actionsSlot ? <div className="flex items-center gap-1 shrink-0">{actionsSlot}</div> : null}
    </div>
  );
}
