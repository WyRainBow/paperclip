import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySkillVersions,
  companySkills,
  feedbackVotes,
  teamRuleNotes,
  teamRuleNoteVersions,
  teamWikiPages,
  teamWikiPageVersions,
  workspaceAssetCitations,
} from "@paperclipai/db";

/**
 * The citation ledger: which team asset was handed to a session, and which one
 * the session says it actually used (MUL-133 decision 61891ec2).
 *
 * Recall writes the `served` half on its own. The `cited` half only exists
 * because an agent declares it, which is the same soft spot teamai-cli
 * documents in its own vote chain — a model that skips the declaration cannot
 * be stopped. What Paperclip adds is that the declaration carries an issue id,
 * so a human can open the card and check whether the rule was really used.
 * That is why `issueId` is the preferred key and `sessionId` only a fallback.
 */

export type AssetKind = "rule" | "wiki" | "skill";

export const ASSET_KINDS: readonly AssetKind[] = ["rule", "wiki", "skill"];

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

export interface AssetRef {
  kind: AssetKind;
  id: string;
  versionId?: string | null;
}

export interface CitationActor {
  companyId: string;
  issueId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}

/** `${kind}:${id}`, the key both the ledger aggregate and the ranking use. */
export function assetKey(kind: AssetKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Record what recall put in front of a session.
 *
 * Never throws. A ledger write failing must not take down the recall that
 * caused it: the caller is on the path of every session start, and a session
 * that gets its rules but loses one ranking signal is strictly better than a
 * session that gets neither.
 */
export async function recordServed(
  db: Db,
  actor: CitationActor,
  query: string,
  hits: Array<AssetRef & { score?: number }>,
): Promise<number> {
  if (hits.length === 0) return 0;
  try {
    const rows = hits.map((hit) => ({
      companyId: actor.companyId,
      issueId: actor.issueId ?? null,
      agentId: actor.agentId ?? null,
      sessionId: actor.sessionId ?? null,
      assetKind: hit.kind,
      assetId: hit.id,
      assetVersionId: hit.versionId ?? null,
      phase: "served" as const,
      query,
      score: hit.score ?? null,
    }));
    await db.insert(workspaceAssetCitations).values(rows);
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Record what a session says it actually used. Unlike `served`, a failure here
 * is reported to the caller: the declaration cannot be reconstructed from
 * anything else, so swallowing the error would lose the only copy.
 */
export async function recordCited(db: Db, actor: CitationActor, assets: AssetRef[]): Promise<number> {
  if (assets.length === 0) return 0;
  const rows = assets.map((asset) => ({
    companyId: actor.companyId,
    issueId: actor.issueId ?? null,
    agentId: actor.agentId ?? null,
    sessionId: actor.sessionId ?? null,
    assetKind: asset.kind,
    assetId: asset.id,
    assetVersionId: asset.versionId ?? null,
    phase: "cited" as const,
    query: null,
    score: null,
  }));
  const inserted = await db
    .insert(workspaceAssetCitations)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: workspaceAssetCitations.id });
  return inserted.length;
}

/**
 * Company-wide citation counts, keyed by `${kind}:${id}`.
 *
 * One aggregate for the whole company rather than a per-hit lookup: a company
 * has tens of assets, not thousands, and recall is on the session-start path
 * where an extra round trip per result would be the expensive part.
 */
export async function citedCountsByAsset(db: Db, companyId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      assetKind: workspaceAssetCitations.assetKind,
      assetId: workspaceAssetCitations.assetId,
      count: sql<number>`count(*)::int`,
    })
    .from(workspaceAssetCitations)
    .where(and(eq(workspaceAssetCitations.companyId, companyId), eq(workspaceAssetCitations.phase, "cited")))
    .groupBy(workspaceAssetCitations.assetKind, workspaceAssetCitations.assetId);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(`${row.assetKind}:${row.assetId}`, Number(row.count));
  return counts;
}

/**
 * How much adoption may move a result up the ranking.
 *
 * Capped on purpose. Adoption is a tiebreaker between results that already
 * matched the query, never a way for a popular rule to answer a question it
 * has nothing to do with — an uncapped boost would turn recall into a
 * popularity list and bury the one page that actually covers a rare topic.
 */
export const ADOPTION_BOOST_PER_CITATION = 0.5;
export const ADOPTION_BOOST_CAP = 2.5;

export function adoptionBoost(citedCount: number): number {
  return Math.min(citedCount * ADOPTION_BOOST_PER_CITATION, ADOPTION_BOOST_CAP);
}

export interface AssetHealthRow {
  assetKind: AssetKind;
  assetId: string;
  title: string;
  path: string | null;
  servedCount: number;
  citedCount: number;
  lastServedAt: string | null;
  lastCitedAt: string | null;
  /** Served enough to have had its chance, and never once cited. */
  deadWeight: boolean;
  /** Down votes pinned to any version of this asset (MUL-133 件二). */
  downVotes: number;
  /** Issues those down votes came from — one row each, for spread checks. */
  downVoteIssueIds: string[];
  /**
   * Down votes from at least two different cards: the problem follows the
   * asset, not one unlucky session.
   */
  disputed: boolean;
  /** Latest pinned revision, the ref a defect vote targets. */
  latestVersionId: string | null;
  latestRevisionNumber: number | null;
  /** When the asset last changed. Surfaced for a human; 久未动 is a judgement call, not a flag. */
  lastRevisedAt: string | null;
}

/**
 * Served enough times that "never cited" means something. Below this an asset
 * is simply new, and calling it dead weight would delete pages before anyone
 * had a chance to use them.
 */
export const DEAD_WEIGHT_MIN_SERVED = 5;

/**
 * Down votes per asset. Votes pin a VERSION id (件二), so attributing them to
 * the asset means joining each version table back to its parent — one query
 * per kind, unioned here.
 */
async function downVotesByAsset(
  db: Db,
  companyId: string,
): Promise<Map<string, { count: number; issueIds: string[] }>> {
  const [ruleRows, skillRows, wikiRows] = await Promise.all([
    db
      .select({
        assetId: teamRuleNoteVersions.noteId,
        issueId: feedbackVotes.issueId,
      })
      .from(feedbackVotes)
      .innerJoin(teamRuleNoteVersions, eq(feedbackVotes.targetId, sql`${teamRuleNoteVersions.id}::text`))
      .where(and(
        eq(feedbackVotes.companyId, companyId),
        eq(feedbackVotes.targetType, "team_rule_note_version"),
        eq(feedbackVotes.vote, "down"),
      )),
    db
      .select({
        assetId: companySkillVersions.companySkillId,
        issueId: feedbackVotes.issueId,
      })
      .from(feedbackVotes)
      .innerJoin(companySkillVersions, eq(feedbackVotes.targetId, sql`${companySkillVersions.id}::text`))
      .where(and(
        eq(feedbackVotes.companyId, companyId),
        eq(feedbackVotes.targetType, "company_skill_version"),
        eq(feedbackVotes.vote, "down"),
      )),
    db
      .select({
        assetId: teamWikiPageVersions.pageId,
        issueId: feedbackVotes.issueId,
      })
      .from(feedbackVotes)
      .innerJoin(teamWikiPageVersions, eq(feedbackVotes.targetId, sql`${teamWikiPageVersions.id}::text`))
      .where(and(
        eq(feedbackVotes.companyId, companyId),
        eq(feedbackVotes.targetType, "team_wiki_page_version"),
        eq(feedbackVotes.vote, "down"),
      )),
  ]);

  const map = new Map<string, { count: number; issueIds: string[] }>();
  const bump = (kind: AssetKind, row: { assetId: string; issueId: string }) => {
    const key = `${kind}:${row.assetId}`;
    const entry = map.get(key) ?? { count: 0, issueIds: [] };
    entry.count += 1;
    if (!entry.issueIds.includes(row.issueId)) entry.issueIds.push(row.issueId);
    map.set(key, entry);
  };
  for (const row of ruleRows) bump("rule", row);
  for (const row of skillRows) bump("skill", row);
  for (const row of wikiRows) bump("wiki", row);
  return map;
}

/**
 * The health view: one row per asset that the ledger has ever touched, plus
 * every asset that exists but has never been served at all.
 *
 * This is a picture for a person to read, not an automatic pruner. Nothing
 * here deletes anything — the counts say which rules to look at, and a human
 * still decides whether a rule is dead or merely waiting for its case.
 */
export async function assetHealth(db: Db, companyId: string): Promise<AssetHealthRow[]> {
  const ledger = await db
    .select({
      assetKind: workspaceAssetCitations.assetKind,
      assetId: workspaceAssetCitations.assetId,
      servedCount: sql<number>`count(*) filter (where ${workspaceAssetCitations.phase} = 'served')::int`,
      citedCount: sql<number>`count(*) filter (where ${workspaceAssetCitations.phase} = 'cited')::int`,
      lastServedAt: sql<string | null>`max(${workspaceAssetCitations.createdAt}) filter (where ${workspaceAssetCitations.phase} = 'served')`,
      lastCitedAt: sql<string | null>`max(${workspaceAssetCitations.createdAt}) filter (where ${workspaceAssetCitations.phase} = 'cited')`,
    })
    .from(workspaceAssetCitations)
    .where(eq(workspaceAssetCitations.companyId, companyId))
    .groupBy(workspaceAssetCitations.assetKind, workspaceAssetCitations.assetId);

  const stats = new Map(ledger.map((row) => [`${row.assetKind}:${row.assetId}`, row]));

  const [rules, wiki, skills, downVotes] = await Promise.all([
    db
      .select({ id: teamRuleNotes.id, title: teamRuleNotes.title })
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.companyId, companyId)),
    db
      .select({ id: teamWikiPages.id, title: teamWikiPages.title, space: teamWikiPages.space, path: teamWikiPages.path })
      .from(teamWikiPages)
      .where(eq(teamWikiPages.companyId, companyId)),
    db
      .select({ id: companySkills.id, name: companySkills.name })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId)),
    downVotesByAsset(db, companyId),
  ]);

  // Latest pinned revision per asset — the ref a defect vote targets.
  // Companies have tens of assets, so fetch the company's version rows and
  // fold latest-per-asset in JS rather than shipping three window functions.
  type LatestVersion = { assetId: string; versionId: string; revisionNumber: number; createdAt: Date };
  const foldLatest = (rows: LatestVersion[]) => {
    const best = new Map<string, LatestVersion>();
    for (const row of rows) {
      const current = best.get(row.assetId);
      if (!current || row.revisionNumber > current.revisionNumber) best.set(row.assetId, row);
    }
    return best;
  };
  const [ruleVersionRows, wikiVersionRows, skillVersionRows] = await Promise.all([
    db
      .select({
        assetId: teamRuleNoteVersions.noteId,
        versionId: teamRuleNoteVersions.id,
        revisionNumber: teamRuleNoteVersions.revisionNumber,
        createdAt: teamRuleNoteVersions.createdAt,
      })
      .from(teamRuleNoteVersions)
      .where(eq(teamRuleNoteVersions.companyId, companyId)),
    db
      .select({
        assetId: teamWikiPageVersions.pageId,
        versionId: teamWikiPageVersions.id,
        revisionNumber: teamWikiPageVersions.revisionNumber,
        createdAt: teamWikiPageVersions.createdAt,
      })
      .from(teamWikiPageVersions)
      .where(eq(teamWikiPageVersions.companyId, companyId)),
    db
      .select({
        assetId: companySkillVersions.companySkillId,
        versionId: companySkillVersions.id,
        revisionNumber: companySkillVersions.revisionNumber,
        createdAt: companySkillVersions.createdAt,
      })
      .from(companySkillVersions)
      .where(eq(companySkillVersions.companyId, companyId)),
  ]);
  const latestVersions = new Map<string, LatestVersion>();
  for (const row of foldLatest(ruleVersionRows).values()) latestVersions.set(`rule:${row.assetId}`, row);
  for (const row of foldLatest(wikiVersionRows).values()) latestVersions.set(`wiki:${row.assetId}`, row);
  for (const row of foldLatest(skillVersionRows).values()) latestVersions.set(`skill:${row.assetId}`, row);

  const rows: AssetHealthRow[] = [];
  const push = (kind: AssetKind, id: string, title: string, path: string | null) => {
    const stat = stats.get(`${kind}:${id}`);
    const servedCount = stat?.servedCount ?? 0;
    const citedCount = stat?.citedCount ?? 0;
    const downVote = downVotes.get(`${kind}:${id}`);
    const latest = latestVersions.get(`${kind}:${id}`);
    rows.push({
      assetKind: kind,
      assetId: id,
      title,
      path,
      servedCount,
      citedCount,
      lastServedAt: stat?.lastServedAt ?? null,
      lastCitedAt: stat?.lastCitedAt ?? null,
      deadWeight: servedCount >= DEAD_WEIGHT_MIN_SERVED && citedCount === 0,
      downVotes: downVote?.count ?? 0,
      downVoteIssueIds: downVote?.issueIds ?? [],
      disputed: (downVote?.issueIds.length ?? 0) >= 2,
      latestVersionId: latest?.versionId ?? null,
      latestRevisionNumber: latest?.revisionNumber ?? null,
      lastRevisedAt: latest ? new Date(latest.createdAt).toISOString() : null,
    });
  };

  for (const row of rules) push("rule", row.id, row.title, null);
  for (const row of wiki) push("wiki", row.id, row.title, `${row.space}/${row.path}`);
  for (const row of skills) push("skill", row.id, row.name, null);

  rows.sort((a, b) => b.servedCount - a.servedCount || b.citedCount - a.citedCount);
  return rows;
}
