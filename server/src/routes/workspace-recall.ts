import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamWikiPages, teamRuleNotes, agents, issues } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { type AssetKind, adoptionBoost, citedCountsByAsset, recordServed } from "../services/asset-citations.js";

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

interface RecallHit {
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

    // The query is a set of terms, not one literal substring. Matching the
    // whole string verbatim meant any multi-word query silently missed: "skills
    // 改内容" found nothing while the page written about exactly that sat in
    // the wiki, because those characters never appear contiguously. Each term
    // must appear somewhere in the row (any field), so word order and spacing
    // stop mattering; a single-term query behaves exactly as before. This is
    // the cheap fix — semantic recall stays parked per MUL-80's verdict, and
    // this failure was tokenization, not semantics.
    const terms = query.split(/\s+/).filter((term) => term.length > 0);

    /** First position of any term in the text, plus how many terms hit it. */
    const matchIn = (text: string): { idx: number; matched: number } => {
      const lower = text.toLowerCase();
      let idx = -1;
      let matched = 0;
      for (const term of terms) {
        const i = lower.indexOf(term.toLowerCase());
        if (i >= 0) {
          matched += 1;
          if (idx < 0 || i < idx) idx = i;
        }
      }
      return { idx, matched };
    };

    // Team Wiki: every term must hit title, body, or path
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
          ...terms.map((term) =>
            or(
              ilike(teamWikiPages.title, `%${term}%`),
              ilike(teamWikiPages.body, `%${term}%`),
              ilike(teamWikiPages.path, `%${term}%`),
            ),
          ),
        ),
      )
      .limit(30);

    for (const row of wikiRows) {
      const { idx, matched } = matchIn(row.body);
      const start = Math.max(0, idx - 100);
      const snippet = row.body.slice(start, start + Math.min(400, row.body.length - start));
      const boost = adoptionBoost(citedCounts.get(`wiki:${row.id}`) ?? 0);
      hits.push({
        source: "wiki",
        space: row.space,
        path: row.path,
        title: row.title,
        snippet: idx >= 0 ? (start > 0 ? "…" : "") + snippet : row.body.slice(0, 300) + "…",
        score: (idx >= 0 ? 1 + matched : 1) + boost,
        assetKind: "wiki",
        assetId: row.id,
        adoptionBoost: boost,
      });
    }

    // Team Rules: every term must hit title or body
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
          ...terms.map((term) =>
            or(
              ilike(teamRuleNotes.title, `%${term}%`),
              ilike(teamRuleNotes.body, `%${term}%`),
            ),
          ),
        ),
      )
      .limit(10);

    for (const row of rulesRows) {
      const { idx, matched } = matchIn(row.body);
      const start = Math.max(0, idx - 100);
      const snippet = row.body.slice(start, start + Math.min(400, row.body.length - start));
      const boost = adoptionBoost(citedCounts.get(`rule:${row.id}`) ?? 0);
      hits.push({
        source: "rules",
        space: null,
        path: `team-rules/${row.id.slice(0, 8)}`,
        title: row.title,
        snippet: idx >= 0 ? (start > 0 ? "…" : "") + snippet : row.body.slice(0, 300) + "…",
        score: (idx >= 0 ? 1 + matched : 1) + boost,
        assetKind: "rule",
        assetId: row.id,
        adoptionBoost: boost,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, MAX_RESULTS);

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
