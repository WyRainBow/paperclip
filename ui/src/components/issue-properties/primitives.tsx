import type { CSSProperties, ReactNode } from "react";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { AgentIcon } from "@/components/AgentIconPicker";
import { t } from "@/i18n";
import { cn } from "../../lib/utils";

export function PropertySection({
  children,
  className,
  title,
  first,
}: {
  children: ReactNode;
  className?: string;
  /** Labeled section header (§4). When set, renders the uppercase header above the rows. */
  title?: string;
  /** First section drops the top padding on its header. */
  first?: boolean;
}) {
  return (
    <div className={className}>
      {title ? (
        <div
          className={cn(
            "text-xs font-semibold uppercase tracking-wide text-muted-foreground pb-1",
            first ? "pt-0" : "pt-3",
          )}
        >
          {title}
        </div>
      ) : null}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function PropertyRow({
  label,
  children,
  wrap,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Opt-in wrapping for chip-collection rows only (§5). Default rows stay one line. */
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 gap-3 py-1",
        wrap ? "items-start" : "items-center",
      )}
      data-property-row="true"
    >
      <span
        className={cn(
          "text-xs text-muted-foreground shrink-0 w-24 truncate",
          wrap && "mt-0.5",
        )}
        data-property-label={typeof label === "string" ? label : undefined}
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
      <div className={cn("flex min-w-0 flex-1 items-center gap-1.5", wrap && "flex-wrap")}>{children}</div>
    </div>
  );
}

export function PropertyChip({
  children,
  className,
  style,
  title,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Tooltip override for chips whose children are not a bare string. */
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      // Badge chassis; keep this chip's truncation + normal weight + start alignment.
      className={cn("max-w-full min-w-0 justify-start truncate font-normal", className)}
      style={style}
      title={title ?? (typeof children === "string" ? children : undefined)}
    >
      {children}
    </Badge>
  );
}

/**
 * A session row: who it was, then the session id. The id alone identifies a
 * session but not a participant — two ids side by side are indistinguishable
 * to a reader, so the name carries recognition and the id carries traceability.
 *
 * Cards are usually opened by a terminal agent rather than a person, so the
 * agent branch is the common case, not the fallback.
 */
export function SessionIdentity({
  agentId,
  agentName,
  agentIcon,
  agentCustomIconUrl,
  userId,
  sessionId,
  tag,
  live,
}: {
  agentId: string | null;
  agentName: string | null;
  agentIcon?: string | null;
  agentCustomIconUrl?: string | null;
  userId: string | null;
  sessionId: string | null;
  tag?: string;
  live?: boolean;
}) {
  const label = agentId ? (agentName ?? agentId.slice(0, 8)) : userId;
  if (!label && !sessionId) {
    return <span className="text-sm text-muted-foreground">{t("Unknown")}</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {label && (
        <span className="flex min-w-0 items-center gap-1.5">
          {agentId ? (
            <AgentIcon icon={agentIcon} customIconUrl={agentCustomIconUrl} className="h-3.5 w-3.5 shrink-0" />
          ) : null}
          <span className="truncate text-sm">{label}</span>
        </span>
      )}
      {sessionId && (
        <span
          className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 font-mono text-(length:--text-micro) text-muted-foreground"
          title={sessionId}
        >
          {shortSessionId(sessionId)}
        </span>
      )}
      {tag && (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-(length:--text-micro) text-muted-foreground">
          {tag}
        </span>
      )}
      {live && (
        <span className="flex shrink-0 items-center gap-1 text-(length:--text-micro) text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          {t("Running")}
        </span>
      )}
    </div>
  );
}

/** `sess_1ecef3b3-9a23-…` → `sess_1ecef3b3`; the full id stays in the tooltip. */
function shortSessionId(sessionId: string) {
  const withoutPrefix = sessionId.startsWith("sess_") ? sessionId.slice(5) : sessionId;
  const head = withoutPrefix.split("-")[0] ?? withoutPrefix;
  return sessionId.startsWith("sess_") ? `sess_${head}` : head;
}

/**
 * A pull request work product. `status` (is it still open) and `reviewState`
 * (what did review conclude) are separate chips on purpose — a PR can be open
 * *and* have changes requested, and collapsing them to one word drops half of
 * that.
 */
export function PullRequestValue({ workProduct }: { workProduct: IssueWorkProduct }) {
  const number = workProduct.externalId ? `#${workProduct.externalId}` : workProduct.title;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {workProduct.url ? (
        <a
          href={workProduct.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-medium text-primary hover:underline"
        >
          {number}
        </a>
      ) : (
        <span className="truncate text-sm font-medium">{number}</span>
      )}
      {workProduct.status && (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-(length:--text-micro) text-muted-foreground">
          {workProduct.status}
        </span>
      )}
      {workProduct.reviewState && workProduct.reviewState !== "none" && (
        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-(length:--text-micro) text-amber-700 dark:text-amber-300">
          {workProduct.reviewState.replaceAll("_", " ")}
        </span>
      )}
    </div>
  );
}
