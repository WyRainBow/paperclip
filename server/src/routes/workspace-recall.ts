import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  teamWikiPages,
  teamRuleNotes,
  agents,
  issues,
  issueDocuments,
  documents,
  decisions,
  cases,
} from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import {
  type AssetKind,
  adoptionBoost,
  citedCountsByAsset,
  recordRecallQuery,
  recordServed,
} from "../services/asset-citations.js";
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
import { SOURCE_WEIGHT, fetchSourceRows, type RecallSource } from "../services/recall-corpus.js";
import { EMBEDDING_SECRET_NAME, resolveEmbeddingConfig } from "../services/recall-embedding-config.js";
import { reindexCompany } from "../services/recall-indexer.js";
import { semanticSearch } from "../services/recall-semantic.js";

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
// 注入预算的上限，单位是 estimateTokens 估出来的 token 不是字符——CJK×1.5 +
// 其他×0.25，同样 100 字符纯中文 150 token、纯英文 25 token，用字符数当指标会
// 让中文规则被严重低估。超预算不截断只警告，理由见下方 directory 分支。
const MAX_BUDGET_TOKENS = 6000;
const MAX_RESULTS = 8;
/** How many query terms may reach SQL. Bigrams multiply fast on a long question. */
const MAX_SQL_TERMS = 12;
/** Rows pulled per source before in-process ranking narrows them to MAX_RESULTS. */
const CANDIDATE_LIMIT = 60;

/**
 * How many semantic hits the vector leg may contribute before merging.
 *
 * Larger than MAX_RESULTS on purpose: dedupe by source and the coverage floor
 * both drop entries afterwards, so the leg needs headroom to still have
 * something left to offer.
 */
const SEMANTIC_LIMIT = 24;

/**
 * Weight of a semantic match relative to a keyword one.
 *
 * Below 1 because the vector leg is the less reliable of the two. Measured
 * 2026-08-30 on the real wiki: of eight questions it got four exactly right and
 * two wrong, while the keyword leg after the MUL-441 fixes got five right. The
 * legs are complementary rather than ranked — this weight keeps a confident
 * vector guess from displacing a literal match, without discarding the case
 * where the wording shares nothing and only the vector leg can answer.
 */
const SEMANTIC_WEIGHT = 0.8;

interface RecallHit extends RankableHit {
  source: RecallSource;
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
   *
   * Null for the non-asset sources. An issue is not a Team asset, so citing one
   * would put rows into the adoption ledger that its ranking signal was never
   * meant to carry.
   */
  assetKind: AssetKind | null;
  assetId: string;
  /** How much of this hit's score came from prior adoption, not from the query. */
  adoptionBoost: number;
  /** Cosine similarity from the vector leg, 0 when it contributed nothing. */
  similarity: number;
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
      ? Math.min(Math.max(budgetRaw, 200), MAX_BUDGET_TOKENS)
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

    // Attribution, resolved before any search work.
    //
    // Moved ahead of ranking in MUL-449 so both miss paths can record with the
    // same attribution the served rows get, and so a malformed issue id fails
    // before a search is spent on it.
    //
    // `recordServed` and `recordMiss` swallow their own errors (a ledger write
    // must not fail recall), so a bad issue id reaching the insert would not
    // 500 — it would silently drop the whole batch and the signal with it.
    // Failing with a 400 keeps the caller's typo loud, and the company check
    // keeps a cross-company card id out of this company's ledger.
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
        .limit(1);
      if (!issueRow) throw badRequest(`issue "${servedIssueIdRaw}" not found in this company`);
      servedIssueId = issueRow.id;
    }
    const servedSessionId = typeof req.query.session === "string" ? req.query.session.slice(0, 200) : null;
    const ledgerActor = {
      companyId,
      issueId: servedIssueId,
      agentId: req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
      sessionId: servedSessionId,
    };

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
    if (sqlTerms.length === 0) {
      // A query that tokenizes to nothing is the most extreme failure there is,
      // and the one most worth seeing: it means the tokenizer failed, not the
      // corpus. Recorded before the 400 so the error does not swallow it.
      await recordRecallQuery(db, ledgerActor, query, {
        termCount: 0,
        candidateCount: 0,
        semanticUsed: false,
        resultCount: 0,
      });
      throw badRequest("q has no searchable terms");
    }

    // Keyword candidates. The corpus definition lives in `recall-corpus` so the
    // indexer embeds exactly the set recall searches — defining it here meant
    // the two could drift apart silently.
    const rows = await fetchSourceRows(db, companyId, {
      terms: sqlTerms,
      limitPerSource: CANDIDATE_LIMIT,
    });

    // Semantic leg. Everything about it degrades to "no extra rows": switch
    // off, no key, no index yet, provider down, rate limited. The keyword leg
    // answers the query in every one of those states, which is why none of them
    // is treated as an error.
    const embeddingConfig = await resolveEmbeddingConfig(db, companyId).catch(() => null);
    const semanticHits = embeddingConfig
      ? await semanticSearch(db, companyId, embeddingConfig, query, SEMANTIC_LIMIT)
      : [];

    // Similarity is keyed per chunk, not per source. Keying it per source would
    // hand every chunk of a long document the score its best chunk earned, so
    // one relevant section would drag thirty irrelevant ones in with it — and
    // the snippet would have no idea which section to point at.
    //
    // The chunk index lines up because both sides call `chunkBody` with the
    // same defaults on the same text. A body that changed since indexing gets a
    // new content hash and is re-embedded, so the two cannot drift apart
    // without the indexer noticing.
    const semanticByChunk = new Map<string, number>();
    for (const hit of semanticHits) {
      semanticByChunk.set(
        `${hit.sourceKind}:${hit.sourceId}:${hit.chunkIndex}`,
        hit.similarity,
      );
    }

    // Rows the keyword leg never saw.
    //
    // Fetching those is the entire point of the semantic leg: a page that
    // shares no wording with the query cannot appear in the SQL candidates, so
    // without this second fetch a vector hit on it would have nothing to attach
    // to and would be silently dropped.

    const knownIds = new Set(rows.map((row) => `${row.sourceKind}:${row.sourceId}`));
    const missingByKind: Partial<Record<RecallSource, string[]>> = {};
    for (const hit of semanticHits) {
      if (knownIds.has(`${hit.sourceKind}:${hit.sourceId}`)) continue;
      const kind = hit.sourceKind as RecallSource;
      (missingByKind[kind] ??= []).push(hit.sourceId);
    }
    if (Object.keys(missingByKind).length > 0) {
      const extra = await fetchSourceRows(db, companyId, {
        limitPerSource: SEMANTIC_LIMIT,
        idsByKind: missingByKind,
      });
      rows.push(...extra);
    }
    // Chunk before scoring. Team Rules is one row covering every topic the team
    // has, so scored whole it outranks every focused wiki page on every query
    // (measured 2026-08-30: top spot on seven of eight). Split into sections it
    // competes section against page, which is the comparison that means
    // something. `rankAndDedupe` keeps one chunk per source afterwards.
    const chunked = rows.flatMap((row) =>
      chunkBody(row.body).map((chunk, chunkIndex) => ({
        row,
        chunkIndex,
        offset: chunk.offset,
        candidate: {
          sourceKey: row.sourceKey,
          title: row.title,
          body: chunk.text,
        } satisfies ScorableCandidate,
      })),
    );

    // Weights are computed over the chunks actually retrieved, so a term that
    // narrows this result set counts for more than one every chunk shares.
    const weights = buildTermWeights(
      chunked.map((entry) => entry.candidate),
      terms,
    );

    for (const entry of chunked) {
      const scored = scoreCandidate(entry.candidate, weights);
      const similarity =
        semanticByChunk.get(
          `${entry.row.sourceKind}:${entry.row.sourceId}:${entry.chunkIndex}`,
        ) ?? 0;
      // A row reaches the results if either leg wants it. Requiring both would
      // throw away exactly the cases each leg exists to cover: the literal
      // match on wording the vectors find unremarkable, and the paraphrase that
      // shares no characters with the query.
      if (scored.coverage < MIN_COVERAGE && similarity <= 0) continue;
      const boost = entry.row.assetKind
        ? adoptionBoost(citedCounts.get(entry.row.sourceKey) ?? 0)
        : 0;
      // Snippet offsets are chunk-relative; shift them back onto the full body
      // so the reader gets surrounding context, not a window clipped at the
      // chunk seam.
      //
      // A pure semantic hit has no keyword offset to shift, and falling back to
      // the head of the body would show the reader the document's opening
      // instead of the section that actually matched. The chunk's own start is
      // the right anchor there: it is the text the vector scored.
      const bodyIndex =
        scored.bodyIndex >= 0 ? scored.bodyIndex + entry.offset : similarity > 0 ? entry.offset : -1;
      hits.push({
        source: entry.row.source,
        space: entry.row.space,
        path: entry.row.path,
        title: entry.row.title,
        snippet: buildSnippet(entry.row.body, bodyIndex),
        // Adoption boost is added after the source weight, not scaled by it:
        // it is evidence a session actually used the asset, and that evidence
        // should not be discounted for being attached to one source or another.
        score:
          (scored.score + similarity * SEMANTIC_WEIGHT) * SOURCE_WEIGHT[entry.row.source] + boost,
        assetKind: entry.row.assetKind,
        assetId: entry.row.sourceId,
        adoptionBoost: boost,
        sourceKey: entry.row.sourceKey,
        matched: scored.matched,
        coverage: scored.coverage,
        bodyIndex,
        similarity,
      });
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
    //
    // Only Team assets get a citable ref. The card-shaped sources are listed
    // with their identifier instead, so the caller can still find what it read
    // without being handed a ref that `workspace cite` would reject.
    const references = results
      .map((hit) => {
        const label = `[${hit.source}${hit.space ? `/${hit.space}` : ""}] ${hit.path ?? hit.title}`;
        return hit.assetKind ? `${label} → ${hit.assetKind}:${hit.assetId}` : label;
      })
      .join("\n");
    // The served half of the ledger. Written after the response is assembled
    // and before it is sent, so what is recorded is exactly what the caller
    // received — including the degraded, title-only entries, which were still
    // put in front of the session and still spent budget.
    //
    // Attribution was resolved before the search (see `ledgerActor` above), so
    // both halves and the miss path record the same actor.
    // The other half of the picture, added in MUL-449: one row per search,
    // whatever the outcome. A query that found nothing used to leave no trace,
    // which is why MUL-80 spent two months waiting for a failure a human
    // eventually had to produce by hand. Recording only the empty ones turned
    // out to miss the common case — measured on the real corpus, questions
    // built to have no answer still returned results, so the failure worth
    // catching is "only noise" rather than "nothing" (decision 37dc4085).
    //
    // Nothing here judges quality. `topScore` and `topCoverage` are stored so
    // the threshold can be chosen later from a real distribution instead of
    // guessed now and baked into the write path.
    await recordRecallQuery(db, ledgerActor, query, {
      termCount: terms.length,
      // What survived df pruning. Measured on the real corpus, this is the
      // column that separates noise from a real answer: a question about
      // something the corpus knows nothing about still scored coverage 1.000,
      // because pruning left it one generic bigram which then matched
      // perfectly. Twelve terms reduced to one is the tell, not the coverage.
      scoringTermCount: weights.terms.length,
      candidateCount: rows.length,
      semanticUsed: embeddingConfig !== null,
      resultCount: results.length,
      topScore: results[0]?.score ?? null,
      topCoverage: results[0]?.coverage ?? null,
    });
    await recordServed(
      db,
      ledgerActor,
      query,
      // Non-asset sources are left out of the ledger entirely. The served/cited
      // ratio drives asset adoption ranking (MUL-133), and an issue that can
      // never be cited would sit in it as permanent dead weight.
      results
        .filter((hit): hit is typeof hit & { assetKind: AssetKind } => hit.assetKind !== null)
        .map((hit) => ({ kind: hit.assetKind, id: hit.assetId, score: hit.score })),
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

  /**
   * Rebuilds this company's vector index (MUL-441).
   *
   * Explicit rather than automatic on write. Embedding costs money and reaches
   * an external provider, so it happens when someone asks for it, and the reply
   * says exactly what it did: how many chunks were scanned, how many were
   * actually re-embedded, how many tokens that cost. Incremental by content
   * hash, so the second call over an unchanged corpus embeds nothing.
   */
  r.post("/companies/:companyId/workspace/recall/reindex", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const config = await resolveEmbeddingConfig(db, companyId);
    if (!config) {
      // Which of the three reasons applies is deliberately not reported: the
      // caller's next step is the same for all of them, and naming them would
      // tell an unauthorized reader whether a key exists.
      res.status(409).json({
        error:
          "semantic recall is not configured: set PAPERCLIP_RECALL_SEMANTIC and store a "
          + `${EMBEDDING_SECRET_NAME} company secret`,
      });
      return;
    }

    const maxChunksRaw = Number.parseInt(String(req.query.maxChunks ?? ""), 10);
    const result = await reindexCompany(db, companyId, config, {
      maxChunks: Number.isInteger(maxChunksRaw) && maxChunksRaw > 0 ? maxChunksRaw : undefined,
    });
    res.json({ model: config.model, provider: config.provider, ...result });
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
