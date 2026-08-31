import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamWikiPages, teamRuleNotes, agents, issues } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { type AssetKind, adoptionBoost, citedCountsByAsset, recordServed } from "../services/asset-citations.js";
import {
  MIN_COVERAGE,
  buildSnippet,
  buildTermWeights,
  chunkBody,
  rankAndDedupe,
  scoreCandidate,
  tokenizeQuery,
  type RankableHit,
  type ScorableCandidate,
} from "../services/recall-ranking.js";

const DEFAULT_BUDGET_CHARS = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CJK-aware token estimation (OV pattern): CJK chars ≈ 1.5 tokens,
// ASCII ≈ 0.25 tokens. This is an estimate — the goal is budget
// proportionality, not billing accuracy.
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other * 0.25);
}
const MAX_BUDGET_CHARS = 6000;
const MAX_RESULTS = 8;
/** How many query terms may reach SQL. Bigrams multiply fast on a long question. */
const MAX_SQL_TERMS = 12;
/** Rows pulled per source before in-process ranking narrows them to MAX_RESULTS. */
const CANDIDATE_LIMIT = 60;

interface RecallHit extends RankableHit {
  source: "wiki" | "rules";
  space: string | null;
  path: string | null;
  title: string;
  snippet: string;
  score: number;
  /**
   * The asset's real primary key, carried out to the caller so a session can
   * declare what it used (MUL-133). `path` was never enough for that: a wiki
   * path moves when a page is renamed, and the rules path here is a truncated
   * id built for display. Adoption has to be keyed on something that does not
   * change under the citation.
   */
  assetKind: AssetKind;
  assetId: string;
  /** How much of this hit's score came from prior adoption, not from the query. */
  adoptionBoost: number;
}

/**
 * Server-side context assembler for the workspace recall channel
 * (decision mul40.channel-model: pull, dual-channel). Searches Team Wiki
 * (both spaces) and Team Rules, returns budget-constrained snippets with
 * reference declarations. The caller (CLI or hook) passes a query; this
 * endpoint does budget/limit/ranking in one place so all clients share it.
 */
export function workspaceRecallRoutes(db: Db): Router {
  const r = Router();

  r.get("/companies/:companyId/workspace/recall", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const mode = typeof req.query.mode === "string" ? req.query.mode : "search";
    // Compact directory mode: identity plus a pointer, nothing else.
    //
    // Codex ingests only the opening lines of a SessionStart hook's context and
    // drops the rest — a session there reported the rules "truncated" and then
    // answered a rules question wrong, from the half it could see. Half a
    // rulebook read as if it were whole is worse than none, so that terminal is
    // given the identity line and told to fetch the rules instead of being sent
    // a document it cannot hold (MUL-117).
    const compact = String(req.query.profile ?? "") === "compact";
    // Directory mode: return a compact asset map (titles + paths only) for
    // the SessionStart injection hook; no body search needed.
    const budgetRaw = Number.parseInt(String(req.query.budget ?? ""), 10);
    const budget = Number.isInteger(budgetRaw)
      ? Math.min(Math.max(budgetRaw, 200), MAX_BUDGET_CHARS)
      : DEFAULT_BUDGET_CHARS;

    if (mode === "directory") {
      // OV-aligned: token-based budget, CJK-aware, 10000 token default
      // (user 2026-08-26: match OpenViking's SessionStart budget)
      // Team Rules full text + asset directory needs more budget than
      // search snippets (user 2026-08-26: rules are mandatory reading)
      const wikiPages = await db
        .select({ space: teamWikiPages.space, path: teamWikiPages.path, title: teamWikiPages.title })
        .from(teamWikiPages)
        .where(eq(teamWikiPages.companyId, companyId))
        .limit(100);
      const ruleNotes = await db
        .select({ title: teamRuleNotes.title, body: teamRuleNotes.body })
        .from(teamRuleNotes)
        .where(eq(teamRuleNotes.companyId, companyId))
        .limit(20);

      const lines: string[] = [];
      // Who is asking, answered before anything else (MUL-113). A session used
      // to start knowing the rules but not its own name, so confirming identity
      // meant a human telling it to run `whoami` by hand. The caller already
      // authenticated to reach here, so the answer is free — and stating it
      // where the caller cannot miss it is the whole point.
      //
      // An unauthenticated caller is told so rather than passed over: silently
      // starting with no identity is how a terminal ends up working as
      // local-board under nobody's name, which is the failure MUL-104 chased
      // for a day.
      if (req.actor.type === "agent" && req.actor.agentId) {
        const [agent] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, req.actor.agentId))
          .limit(1);
        lines.push(
          agent?.name
            ? `你是 ${agent.name}（agent id ${req.actor.agentId}）`
            : `你是 agent ${req.actor.agentId}（名称未取到）`,
        );
      } else {
        lines.push(
          "身份未取到：本次请求没有 agent 凭证，当前以 local-board 身份读取。" +
            "终端会话应能自动发现自己的 key（~/.paperclip/keys/<终端>），先修凭证再干活。",
        );
      }
      if (compact) {
        lines.push("");
        lines.push(
          "本次未注入 Team Rules 全文（本终端只能接收开头少量内容，长文会被截断成半部规则）。" +
            "做任何 Paperclip 相关动作之前，先跑一次 `paperclip workspace rules` 读全文，会话内只需一次。",
        );
        const compactText = lines.join("\n");
        res.json({
          mode: "directory",
          profile: "compact",
          text: compactText,
          budgetTokens: null,
          usedTokens: estimateTokens(compactText),
          usedChars: compactText.length,
          overBudget: false,
        });
        return;
      }

      lines.push("");
      lines.push("=== Team Rules（全文） ===");
      for (const note of ruleNotes) {
        lines.push(note.body);
        lines.push("");
      }
      lines.push("=== TeamWorkSpace 资产目录 ===");
      for (const space of ["paperclip", "agent", "personal"]) {
        const pages = wikiPages.filter((p) => p.space === space);
        if (pages.length > 0) {
          lines.push(`Team Wiki / ${space}:`);
          for (const p of pages) lines.push(`  ${p.path} — ${p.title}`);
        }
      }
      lines.push("");
      lines.push("查询正文：paperclipai workspace recall --query <关键词> [--budget N]");

      const mapText = lines.join("\n");
      const tokenBudget = Math.max(budget, 2000); // directory mode uses larger budget
      const usedTokens = estimateTokens(mapText);

      // Over budget warns instead of truncating (decision 6ce7c5f1). This used
      // to cut the text mid-line, and the cut lands wherever the byte count
      // says — in practice the tail of the asset directory, sometimes the tail
      // of a rule. A session holding half a rulebook does not know which half
      // is missing and follows the remainder as if it were complete, which is
      // worse than a context that is merely too large. Growing past the budget
      // is a real problem, so it is stated at the top where a reader cannot
      // miss it, and left to a human to fix by trimming the rules.
      // The warning goes after the identity line, never before it: Team Rules
      // §0 tells every session that the opening line is who it is, so anything
      // that displaces it breaks the contract sessions are told to rely on.
      const overBudget = usedTokens > tokenBudget;
      let text = mapText;
      if (overBudget) {
        const warning = `⚠ Team Rules 与资产目录合计 ${usedTokens} token，已超出注入预算 ${tokenBudget} token。内容仍然完整，但每个会话都在付这份开销，该精简了。`;
        const [identityLine, ...rest] = mapText.split("\n");
        text = [identityLine, "", warning, ...rest].join("\n");
      }
      res.json({ mode: "directory", text, budgetTokens: tokenBudget, usedTokens, usedChars: text.length, overBudget });
      return;
    }

    if (!query) throw badRequest("q is required");


    const hits: RecallHit[] = [];

    // Adoption counts for the whole company, fetched once. Assets a session
    // previously declared it used rank above equally-relevant ones that
    // nobody has ever cited (MUL-133 decision 61891ec2, option b).
    const citedCounts = await citedCountsByAsset(db, companyId);

    // Tokenization and scoring live in `recall-ranking` (MUL-441), shared with
    // the other recall consumers. The rule this replaced split on whitespace
    // and required every term to hit. That is correct for English and useless
    // for Chinese: a Chinese query carries no spaces, so the whole sentence
    // became one token and went into `ilike '%整句话%'`, which matches nothing.
    // Measured 2026-08-30 against the real wiki: eight Chinese questions, zero
    // hits, all eight for that reason.
    const { terms } = tokenizeQuery(query);
    // SQL only narrows the candidate set. Ranking happens in-process, where the
    // corpus-wide term weights are known. Capping the term count keeps a long
    // question from building a hundred-clause OR.
    const sqlTerms = terms.slice(0, MAX_SQL_TERMS);
    if (sqlTerms.length === 0) throw badRequest("q has no searchable terms");

    // Team Wiki: any term hitting title, body, or path makes it a candidate
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
          or(
            ...sqlTerms.flatMap((term) => [
              ilike(teamWikiPages.title, `%${term}%`),
              ilike(teamWikiPages.body, `%${term}%`),
              ilike(teamWikiPages.path, `%${term}%`),
            ]),
          ),
        ),
      )
      .limit(CANDIDATE_LIMIT);

    // Team Rules: any term hitting title or body
    const rulesRows = await db
      .select({
        id: teamRuleNotes.id,
        title: teamRuleNotes.title,
        body: teamRuleNotes.body,
      })
      .from(teamRuleNotes)
      .where(
        and(
          eq(teamRuleNotes.companyId, companyId),
          or(
            ...sqlTerms.flatMap((term) => [
              ilike(teamRuleNotes.title, `%${term}%`),
              ilike(teamRuleNotes.body, `%${term}%`),
            ]),
          ),
        ),
      )
      .limit(CANDIDATE_LIMIT);

    // Chunk before scoring. Team Rules is one row covering every topic the team
    // has, so scored whole it outranks every focused wiki page on every query
    // (measured 2026-08-30: top spot on seven of eight). Split into sections it
    // competes section against page, which is the comparison that means
    // something. `rankAndDedupe` keeps one chunk per source afterwards.
    interface Chunked {
      sourceKey: string;
      candidate: ScorableCandidate;
      offset: number;
      row:
        | { kind: "wiki"; id: string; space: string | null; path: string; title: string; body: string }
        | { kind: "rule"; id: string; title: string; body: string };
    }

    const chunked: Chunked[] = [];
    for (const row of wikiRows) {
      const sourceKey = `wiki:${row.id}`;
      for (const chunk of chunkBody(row.body)) {
        chunked.push({
          sourceKey,
          offset: chunk.offset,
          candidate: { sourceKey, title: row.title, body: chunk.text },
          row: { kind: "wiki", id: row.id, space: row.space, path: row.path, title: row.title, body: row.body },
        });
      }
    }
    for (const row of rulesRows) {
      const sourceKey = `rule:${row.id}`;
      for (const chunk of chunkBody(row.body)) {
        chunked.push({
          sourceKey,
          offset: chunk.offset,
          candidate: { sourceKey, title: row.title, body: chunk.text },
          row: { kind: "rule", id: row.id, title: row.title, body: row.body },
        });
      }
    }

    // Weights are computed over the chunks actually retrieved, so a term that
    // narrows this result set counts for more than one every chunk shares.
    const weights = buildTermWeights(
      chunked.map((entry) => entry.candidate),
      terms,
    );

    for (const entry of chunked) {
      const scored = scoreCandidate(entry.candidate, weights);
      if (scored.coverage < MIN_COVERAGE) continue;
      const boost = adoptionBoost(citedCounts.get(entry.sourceKey) ?? 0);
      // Snippet offsets are chunk-relative; shift them back onto the full body
      // so the reader gets surrounding context, not a window clipped at the
      // chunk seam.
      const bodyIndex = scored.bodyIndex >= 0 ? scored.bodyIndex + entry.offset : -1;
      const common = {
        score: scored.score + boost,
        adoptionBoost: boost,
        sourceKey: entry.sourceKey,
        matched: scored.matched,
        coverage: scored.coverage,
        bodyIndex,
      };
      if (entry.row.kind === "wiki") {
        hits.push({
          ...common,
          source: "wiki",
          space: entry.row.space,
          path: entry.row.path,
          title: entry.row.title,
          snippet: buildSnippet(entry.row.body, bodyIndex),
          assetKind: "wiki",
          assetId: entry.row.id,
        });
      } else {
        hits.push({
          ...common,
          source: "rules",
          space: null,
          path: `team-rules/${entry.row.id.slice(0, 8)}`,
          title: entry.row.title,
          snippet: buildSnippet(entry.row.body, bodyIndex),
          assetKind: "rule",
          assetId: entry.row.id,
        });
      }
    }

    const top = rankAndDedupe(hits, { limit: MAX_RESULTS });

    // Budget assembly: fit as many full snippets as possible, degrade to
    // title-only lines when the budget runs out (OV's degradation pattern).
    const results: Array<RecallHit & { degraded: boolean }> = [];
    let used = 0;
    for (const hit of top) {
      const cost = hit.snippet.length + hit.title.length + 60;
      if (used + cost <= budget) {
        results.push({ ...hit, degraded: false });
        used += cost;
      } else {
        results.push({ ...hit, snippet: "", degraded: true });
      }
    }

    // Each reference line ends with the ref the caller pastes back into
    // `workspace cite`. Making the declaration a copy of a line already on
    // screen is the whole trick: teamai-cli's equivalent asks the model to
    // reconstruct doc ids from memory at the end of a long session, and
    // documents that models simply skip it.
    const references = results
      .map((hit) => `[${hit.source}${hit.space ? `/${hit.space}` : ""}] ${hit.path ?? hit.title} → ${hit.assetKind}:${hit.assetId}`)
      .join("\n");

    // The served half of the ledger. Written after the response is assembled
    // and before it is sent, so what is recorded is exactly what the caller
    // received — including the degraded, title-only entries, which were still
    // put in front of the session and still spent budget.
    //
    // The `issue` param is validated before use. `recordServed` swallows its
    // own errors (a ledger write must not fail recall), so a malformed issue
    // id reaching the insert would not 500 — it would silently drop the whole
    // served batch and the ranking signal with it. Failing the request with a
    // 400 instead keeps the caller's typo loud, and checking company
    // ownership keeps a cross-company card id from leaking into this
    // company's ledger through the insert's plain FK.
    const servedIssueIdRaw = typeof req.query.issue === "string" ? req.query.issue : null;
    let servedIssueId: string | null = null;
    if (servedIssueIdRaw) {
      if (!UUID_RE.test(servedIssueIdRaw)) {
        throw badRequest(`issue "${servedIssueIdRaw}" is not a uuid`);
      }
      const [issueRow] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, servedIssueIdRaw), eq(issues.companyId, companyId)))
        .limit(1);;
      if (!issueRow) throw badRequest(`issue "${servedIssueIdRaw}" not found in this company`);
      servedIssueId = issueRow.id;
    }
    const servedSessionId = typeof req.query.session === "string" ? req.query.session.slice(0, 200) : null;
    await recordServed(
      db,
      {
        companyId,
        issueId: servedIssueId,
        agentId: req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
        sessionId: servedSessionId,
      },
      query,
      results.map((hit) => ({ kind: hit.assetKind, id: hit.assetId, score: hit.score })),
    );

    res.json({
      query,
      budgetChars: budget,
      usedChars: used,
      resultCount: results.length,
      totalHits: hits.length,
      results,
      references,
    });
  });

  // Direct Team Rules access: full text, no search/budget — for agents
  // that need the complete rules before starting work (user 2026-08-26).
  r.get("/companies/:companyId/workspace/rules", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const notes = await db
      .select({
        id: teamRuleNotes.id,
        title: teamRuleNotes.title,
        body: teamRuleNotes.body,
        updatedAt: teamRuleNotes.updatedAt,
              })
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.companyId, companyId))
      .orderBy(asc(teamRuleNotes.position));
    res.json(notes);
  });

  return r;
}
