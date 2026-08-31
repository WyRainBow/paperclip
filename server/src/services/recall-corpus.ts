import { and, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  cases,
  decisions,
  documents,
  issueDocuments,
  issues,
  teamRuleNotes,
  teamWikiPages,
} from "@paperclipai/db";

import type { AssetKind } from "./asset-citations.js";

/**
 * What recall can see, defined once (MUL-441).
 *
 * Three callers need the same answer to "what is in this company's corpus":
 * the recall route (keyword candidates), the indexer (everything, to embed),
 * and the route again (fetching rows a vector hit named but the keyword query
 * missed — which is the entire point of the semantic leg). Defining the corpus
 * in the route meant the indexer would embed a different set of things than
 * recall searches, and the mismatch would be silent.
 */

export type RecallSource = "wiki" | "rules" | "issue" | "document" | "decision" | "case";

export interface SourceRow {
  /** Stable identity for dedupe and for the embedding index. */
  sourceKey: string;
  source: RecallSource;
  /** Kind as stored in `recall_embeddings.source_kind`. */
  sourceKind: RecallSource;
  sourceId: string;
  space: string | null;
  path: string;
  title: string;
  body: string;
  /** Only Team assets carry citation identity; cards and documents are not assets. */
  assetKind: AssetKind | null;
}

/**
 * Per-source multiplier applied to the keyword score.
 *
 * Recall's job is to hand a session the team's settled knowledge. Rules and
 * wiki pages are that: someone decided they were worth writing down and keeping
 * current. Cards and their documents are the raw record the knowledge was
 * distilled from — useful, far more numerous, and written once and left alone.
 * Ranking them flat means the raw record buries the distilled version, because
 * there is simply much more of it.
 *
 * This is a statement about what recall is for, not a tuning knob. Equal
 * relevance goes to the page someone maintains.
 */
export const SOURCE_WEIGHT: Record<RecallSource, number> = {
  rules: 1,
  wiki: 1,
  document: 0.85,
  decision: 0.8,
  case: 0.8,
  issue: 0.75,
};

type Column = Parameters<typeof ilike>[0];

/** Builds the "any term hits any of these columns" filter, or undefined for no terms. */
function anyTerm(terms: string[], columns: Column[]): SQL | undefined {
  if (terms.length === 0) return undefined;
  return or(...terms.flatMap((term) => columns.map((column) => ilike(column, `%${term}%`))));
}

interface FetchOptions {
  /** Keyword filter. Omit to fetch the whole corpus (used by the indexer). */
  terms?: string[];
  limitPerSource: number;
  /** Restricts to these ids per kind. Used to fetch rows a vector hit named. */
  idsByKind?: Partial<Record<RecallSource, string[]>>;
}

function idFilter(options: FetchOptions, kind: RecallSource, column: Column): SQL | undefined {
  const ids = options.idsByKind?.[kind];
  if (!ids) return undefined;
  if (ids.length === 0) return undefined;
  return inArray(column as never, ids);
}

/** True when this kind should be skipped entirely for an id-restricted fetch. */
function skipKind(options: FetchOptions, kind: RecallSource): boolean {
  if (!options.idsByKind) return false;
  const ids = options.idsByKind[kind];
  return !ids || ids.length === 0;
}

/**
 * Fetches candidate rows across every source.
 *
 * Archived and hidden cards stay out. Recall answers "what do we know", and a
 * card someone deliberately filed away is not part of that answer.
 */
export async function fetchSourceRows(
  db: Db,
  companyId: string,
  options: FetchOptions,
): Promise<SourceRow[]> {
  const terms = options.terms ?? [];
  const rows: SourceRow[] = [];
  const limit = options.limitPerSource;

  if (!skipKind(options, "wiki")) {
    const wikiRows = await db
      .select({
        id: teamWikiPages.id,
        space: teamWikiPages.space,
        path: teamWikiPages.path,
        title: teamWikiPages.title,
        body: teamWikiPages.body,
      })
      .from(teamWikiPages)
      .where(
        and(
          eq(teamWikiPages.companyId, companyId),
          anyTerm(terms, [teamWikiPages.title, teamWikiPages.body, teamWikiPages.path]),
          idFilter(options, "wiki", teamWikiPages.id),
        ),
      )
      .limit(limit);
    for (const row of wikiRows) {
      rows.push({
        sourceKey: `wiki:${row.id}`,
        source: "wiki",
        sourceKind: "wiki",
        sourceId: row.id,
        space: row.space,
        path: row.path,
        title: row.title,
        body: row.body,
        assetKind: "wiki",
      });
    }
  }

  if (!skipKind(options, "rules")) {
    const rulesRows = await db
      .select({ id: teamRuleNotes.id, title: teamRuleNotes.title, body: teamRuleNotes.body })
      .from(teamRuleNotes)
      .where(
        and(
          eq(teamRuleNotes.companyId, companyId),
          anyTerm(terms, [teamRuleNotes.title, teamRuleNotes.body]),
          idFilter(options, "rules", teamRuleNotes.id),
        ),
      )
      .limit(limit);
    for (const row of rulesRows) {
      rows.push({
        sourceKey: `rule:${row.id}`,
        source: "rules",
        sourceKind: "rules",
        sourceId: row.id,
        space: null,
        path: `team-rules/${row.id.slice(0, 8)}`,
        title: row.title,
        body: row.body,
        assetKind: "rule",
      });
    }
  }

  if (!skipKind(options, "issue")) {
    const issueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.archivedAt),
          isNull(issues.hiddenAt),
          anyTerm(terms, [issues.title, issues.description]),
          idFilter(options, "issue", issues.id),
        ),
      )
      .limit(limit);
    for (const row of issueRows) {
      rows.push({
        sourceKey: `issue:${row.id}`,
        source: "issue",
        sourceKind: "issue",
        sourceId: row.id,
        space: null,
        // identifier is assigned asynchronously, so a just-created card can
        // still be null here. Falling back to a short id keeps the line usable.
        path: row.identifier ?? `issue/${row.id.slice(0, 8)}`,
        title: row.title,
        body: row.description ?? "",
        assetKind: null,
      });
    }
  }

  if (!skipKind(options, "document")) {
    const documentRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        body: documents.latestBody,
        key: issueDocuments.key,
        identifier: issues.identifier,
      })
      .from(documents)
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
      .where(
        and(
          eq(issueDocuments.companyId, companyId),
          isNull(issues.archivedAt),
          isNull(issues.hiddenAt),
          anyTerm(terms, [documents.title, documents.latestBody]),
          idFilter(options, "document", documents.id),
        ),
      )
      .limit(limit);
    for (const row of documentRows) {
      rows.push({
        sourceKey: `document:${row.id}`,
        source: "document",
        sourceKind: "document",
        sourceId: row.id,
        space: null,
        path: `${row.identifier ?? "issue"}/${row.key}`,
        title: row.title ?? row.key,
        body: row.body,
        assetKind: null,
      });
    }
  }

  if (!skipKind(options, "decision")) {
    const decisionRows = await db
      .select({ id: decisions.id, title: decisions.title, body: decisions.body })
      .from(decisions)
      .where(
        and(
          eq(decisions.companyId, companyId),
          anyTerm(terms, [decisions.title, decisions.body]),
          idFilter(options, "decision", decisions.id),
        ),
      )
      .limit(limit);
    for (const row of decisionRows) {
      rows.push({
        sourceKey: `decision:${row.id}`,
        source: "decision",
        sourceKind: "decision",
        sourceId: row.id,
        space: null,
        path: `decision/${row.id.slice(0, 8)}`,
        title: row.title,
        body: row.body,
        assetKind: null,
      });
    }
  }

  if (!skipKind(options, "case")) {
    const caseRows = await db
      .select({
        id: cases.id,
        identifier: cases.identifier,
        title: cases.title,
        summary: cases.summary,
      })
      .from(cases)
      .where(
        and(
          eq(cases.companyId, companyId),
          anyTerm(terms, [cases.title, cases.summary]),
          idFilter(options, "case", cases.id),
        ),
      )
      .limit(limit);
    for (const row of caseRows) {
      rows.push({
        sourceKey: `case:${row.id}`,
        source: "case",
        sourceKind: "case",
        sourceId: row.id,
        space: null,
        path: row.identifier,
        title: row.title,
        body: row.summary ?? "",
        assetKind: null,
      });
    }
  }

  return rows;
}
