import { and, isNotNull, isNull, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

/**
 * The one place that decides whether an issue shows up on a board, a list, or a
 * search result. Archived issues (MUL-109) are excluded here rather than at each
 * call site, so archiving a card removes it from every surface at once; the
 * archive area asks for them explicitly with `archivedIssueCondition`.
 */
export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind), isNull(issues.archivedAt))!;
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL AND "${alias}"."archived_at" IS NULL`;
}

/** The archive area: cards that were archived instead of deleted. */
export function archivedIssueCondition(): SQL {
  return and(isNotNull(issues.archivedAt), isNull(issues.harnessKind))!;
}
