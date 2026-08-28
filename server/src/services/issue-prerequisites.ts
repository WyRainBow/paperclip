import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { decisions, issueDocuments } from "@paperclipai/db";

/**
 * The close-out prerequisite check (MUL-137, 老板令 2026-08-28).
 *
 * 一个 issue 必须起码有需求底稿、技术方案、决策卡——决策卡必须关联
 * issue。That rule existed as the MUL-37 convention (documents keyed
 * requirements / tech-proposal / spec plus a thin body); this check is the
 * enforcement half, consulted when a card tries to enter in_review or done.
 *
 * The decision linkage itself is already welded at the schema level
 * (`decisions.originIssueId` is a NOT NULL FK), so the check only has to
 * confirm one exists — nothing to enforce there, just to verify.
 *
 * Missing pieces are returned as lines that each name the fix, so the 422
 * tells the caller exactly what to put where instead of a bare "not allowed".
 */
export async function missingIssueClosePrerequisites(
  db: Pick<Db, "select">,
  companyId: string,
  issue: { id: string; description: string | null },
): Promise<string[]> {
  const missing: string[] = [];

  if (!(issue.description ?? "").trim()) {
    missing.push("正文（description）为空——issue update <卡> --description \"> 一句话摘要…\"，厚内容走文档");
  }

  const docRows = await db
    .select({ key: issueDocuments.key })
    .from(issueDocuments)
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.issueId, issue.id),
      inArray(issueDocuments.key, ["requirements", "tech-proposal"]),
    ));
  const keys = new Set(docRows.map((row) => row.key));
  if (!keys.has("requirements")) {
    missing.push("缺「需求底稿」文档——issue document:put <卡> requirements --body-file 底稿.md");
  }
  if (!keys.has("tech-proposal")) {
    missing.push("缺「技术方案」文档——issue document:put <卡> tech-proposal --body-file 方案.md");
  }

  const [decision] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(
      eq(decisions.companyId, companyId),
      eq(decisions.originIssueId, issue.id),
    ))
    .limit(1);
  if (!decision) {
    missing.push("缺关联决策卡——decision create --issue <卡> …（库层 originIssueId 已强制非空，这里只验存在）");
  }

  return missing;
}
