import { sql } from "drizzle-orm";

/**
 * Issues are archive-only (MUL-109). The `issues_forbid_delete` trigger in
 * migration 0237 refuses every DELETE on the table, whatever identity or code
 * path issues it — that is the guarantee, not the application checks layered
 * on top of it.
 *
 * Two paths legitimately still remove rows and must say so explicitly, inside
 * their own transaction:
 *   - tearing down an entire company, which drops every child table anyway;
 *   - a routine rolling back the issue it just created in a failed transaction,
 *     where the card never became a real card.
 *
 * `SET LOCAL` scopes the permission to the surrounding transaction, so it
 * cannot leak into an unrelated statement or a later request on the same
 * pooled connection.
 */
export const ISSUE_DELETE_ESCAPE_SETTING = "paperclip.allow_issue_delete";

type TxLike = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** Runs `fn` with issue deletion permitted for the rest of this transaction. */
export async function withIssueDeleteAllowed<T>(tx: TxLike, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`set local "paperclip.allow_issue_delete" = 'on'`);
  return fn();
}

/** True when the database refused a write because issues are archive-only. */
export function isIssueDeleteForbidden(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const message = (err as { message?: unknown } | null)?.message;
  return code === "23001" && typeof message === "string" && message.includes("archive-only");
}
