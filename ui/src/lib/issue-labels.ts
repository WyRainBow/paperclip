import { t } from "@/i18n";

/**
 * Canonical English display labels for issue statuses and priorities. Values
 * double as i18n natural keys, so `t()` returns the English source text when
 * the active locale has no translation and the translated label otherwise.
 */
const ISSUE_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function humanizeToken(value: string) {
  return value.replace(/[_-]+/g, " ");
}

export function issueStatusLabel(status: string) {
  return t(ISSUE_STATUS_LABELS[status] ?? humanizeToken(status));
}

export function priorityLabel(priority: string) {
  return t(PRIORITY_LABELS[priority] ?? humanizeToken(priority));
}
