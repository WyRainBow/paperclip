import { and, eq, inArray, like, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments } from "@paperclipai/db";

/**
 * Self-reported execution logs (MUL-173): each qualifying working session
 * files an exec-log document on its issue, opening with a fenced
 * ```exec-log JSON block. This module parses that block and aggregates the
 * self-reported metrics for the experience board's "self-reported" layer —
 * a complement to the server-written friction rows, never a replacement:
 * everything here is agent-authored by construction and is labelled as such
 * in the UI.
 */

export interface ExecLogToolTotal {
  tool: string;
  calls: number;
  failed: number;
}

export interface ExecLogFailureCluster {
  count: number;
  subject: string;
  cause: string;
}

export interface ExecLogAttribution {
  cli: number;
  env: number;
  self: number;
  preexisting: number;
}

export interface ExecLogDurationOutlier {
  subject: string;
  ms: number;
  cause: string;
}

export interface ExecLogHeader {
  sessionId: string;
  logPath: string;
  logRange: string;
  summary: string;
  toolTotals: ExecLogToolTotal[];
  failureClusters: ExecLogFailureCluster[];
  attribution: ExecLogAttribution;
  durationOutliers: ExecLogDurationOutlier[];
}

export interface ParsedExecLog {
  header: ExecLogHeader | null;
  parseError: string | null;
}

const EXEC_LOG_BLOCK_RE = /```exec-log\s*\n([\s\S]*?)\n```/;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseToolTotals(value: unknown): ExecLogToolTotal[] {
  return asArray(value)
    .map((entry) => {
      const rec = asRecord(entry);
      const tool = asString(rec.tool).trim();
      if (!tool) return null;
      return { tool, calls: asNumber(rec.calls), failed: asNumber(rec.failed) };
    })
    .filter((entry): entry is ExecLogToolTotal => entry !== null);
}

/**
 * Parse one exec-log document body. Returns null when the body carries no
 * exec-log intent (no fenced block and no recognizable header), a header on
 * success, or a parseError for documents that look like exec-logs but do not
 * parse — degraded, never thrown, so one malformed document cannot break the
 * board query.
 */
export function parseExecLogDocument(body: string | null | undefined): ParsedExecLog | null {
  if (typeof body !== "string" || body.trim().length === 0) return null;
  const match = body.match(EXEC_LOG_BLOCK_RE);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match[1] ?? "");
  } catch {
    return { header: null, parseError: "exec-log block is not valid JSON" };
  }
  const rec = asRecord(raw);
  if (Object.keys(rec).length === 0) {
    return { header: null, parseError: "exec-log block is not an object" };
  }

  const missing: string[] = [];
  const sessionId = asString(rec.sessionId).trim();
  const logPath = asString(rec.logPath).trim();
  const summary = asString(rec.summary).trim();
  if (!sessionId) missing.push("sessionId");
  if (!logPath) missing.push("logPath");
  if (!summary) missing.push("summary");
  if (missing.length > 0) {
    return { header: null, parseError: `missing required fields: ${missing.join(", ")}` };
  }

  return {
    header: {
      sessionId,
      logPath,
      logRange: asString(rec.logRange),
      summary,
      toolTotals: parseToolTotals(rec.toolTotals),
      failureClusters: asArray(rec.failureClusters).map((entry) => {
        const c = asRecord(entry);
        return {
          count: asNumber(c.count),
          subject: asString(c.subject),
          cause: asString(c.cause),
        };
      }),
      attribution: (() => {
        const a = asRecord(rec.attribution);
        return {
          cli: asNumber(a.cli),
          env: asNumber(a.env),
          self: asNumber(a.self),
          preexisting: asNumber(a.preexisting),
        };
      })(),
      durationOutliers: asArray(rec.durationOutliers).map((entry) => {
        const o = asRecord(entry);
        return { subject: asString(o.subject), ms: asNumber(o.ms), cause: asString(o.cause) };
      }),
    },
    parseError: null,
  };
}

export interface ExperienceSelfReported {
  documents: number;
  parsed: number;
  parseErrors: number;
  totalCalls: number;
  failedCalls: number;
  failureRate: number;
  clusters: number;
  latestAt: string | null;
}

/**
 * Load and aggregate the self-reported layer for the given issues. Keys
 * `exec-log*` are the convention (MUL-173); the bare `execution-log` key is
 * grandfathered so MUL-169's legacy log shows up degraded rather than
 * disappearing.
 */
export async function loadSelfReportedForIssues(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, ExperienceSelfReported>> {
  const result = new Map<string, ExperienceSelfReported>();
  if (issueIds.length === 0) return result;

  const rows = await db
    .select({
      issueId: issueDocuments.issueId,
      key: issueDocuments.key,
      body: documents.latestBody,
      updatedAt: issueDocuments.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      inArray(issueDocuments.issueId, issueIds),
      or(
        like(issueDocuments.key, "exec-log%"),
        eq(issueDocuments.key, "execution-log"),
      ),
    ));

  for (const row of rows) {
    const entry = result.get(row.issueId) ?? {
      documents: 0,
      parsed: 0,
      parseErrors: 0,
      totalCalls: 0,
      failedCalls: 0,
      failureRate: 0,
      clusters: 0,
      latestAt: null as string | null,
    };
    entry.documents += 1;
    const parsed = parseExecLogDocument(row.body);
    if (parsed?.header) {
      entry.parsed += 1;
      for (const total of parsed.header.toolTotals) {
        entry.totalCalls += total.calls;
        entry.failedCalls += total.failed;
      }
      for (const cluster of parsed.header.failureClusters) {
        entry.clusters += Math.max(1, cluster.count);
      }
    } else {
      // The key declared exec-log intent but the body has no parsable block —
      // legacy free-form logs (MUL-169's execution-log) land here, degraded
      // rather than invisible.
      entry.parseErrors += 1;
    }
    const at = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null;
    if (at && (!entry.latestAt || at > entry.latestAt)) entry.latestAt = at;
    result.set(row.issueId, entry);
  }

  for (const entry of result.values()) {
    entry.failureRate = entry.totalCalls > 0
      ? Math.round((entry.failedCalls / entry.totalCalls) * 1000) / 1000
      : 0;
  }
  return result;
}
