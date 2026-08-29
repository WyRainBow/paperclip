import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

const AVATAR_SIZE_PX: Record<"xs" | "sm" | "md", number> = {
  xs: 16,
  sm: 24,
  md: 32,
};

/**
 * The `system` actor's avatar: a circle with the product glyph (MUL-150,
 * after Multica's actor-avatar where every system-authored row carries the
 * product logo instead of a person's face). A system notice is nobody's
 * words — the platform's own bookkeeping — so it must never borrow a human
 * or agent identity, and it must read the same wherever it lands.
 */
export function SystemActorAvatar({ size = "sm", className }: { size?: keyof typeof AVATAR_SIZE_PX; className?: string }) {
  const px = AVATAR_SIZE_PX[size];
  return (
    <span
      data-testid="system-actor-avatar"
      aria-label="system"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-muted text-muted-foreground",
        className,
      )}
      style={{ width: px, height: px }}
    >
      <Paperclip style={{ width: px * 0.55, height: px * 0.55 }} aria-hidden />
    </span>
  );
}

/**
 * Inline tag marking a row as platform-generated — "系统通知" for things the
 * platform actively says (notices, reminders), "系统记录" for things it
 * automatically records (status/assignee event rows). MUL-150/151.
 */
export function SystemNoticeTag({ label = "系统通知", className }: { label?: string; className?: string }) {
  return (
    <span
      data-testid="system-notice-tag"
      className={cn(
        "inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-px text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground",
        className,
      )}
    >
      {label}
    </span>
  );
}
