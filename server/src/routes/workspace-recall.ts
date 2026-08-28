import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamWikiPages, teamRuleNotes, agents } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

const DEFAULT_BUDGET_CHARS = 2000;

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
      const overBudget = usedTokens > tokenBudget;
      const text = overBudget
        ? `⚠ Team Rules 与资产目录合计 ${usedTokens} token，已超出注入预算 ${tokenBudget} token。内容仍然完整，但每个会话都在付这份开销，该精简了。\n\n${mapText}`
        : mapText;
      res.json({ mode: "directory", text, budgetTokens: tokenBudget, usedTokens, usedChars: text.length, overBudget });
      return;
    }

    if (!query) throw badRequest("q is required");


    const hits: RecallHit[] = [];

    // Team Wiki: title + body + path ilike
    const wikiRows = await db
      .select({
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
            ilike(teamWikiPages.title, `%${query}%`),
            ilike(teamWikiPages.body, `%${query}%`),
            ilike(teamWikiPages.path, `%${query}%`),
          ),
        ),
      )
      .limit(30);

    for (const row of wikiRows) {
      const idx = row.body.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 100);
      const snippet = row.body.slice(start, start + Math.min(400, row.body.length - start));
      hits.push({
        source: "wiki",
        space: row.space,
        path: row.path,
        title: row.title,
        snippet: idx >= 0 ? (start > 0 ? "…" : "") + snippet : row.body.slice(0, 300) + "…",
        score: idx >= 0 ? 2 : 1,
      });
    }

    // Team Rules: title + body ilike
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
            ilike(teamRuleNotes.title, `%${query}%`),
            ilike(teamRuleNotes.body, `%${query}%`),
          ),
        ),
      )
      .limit(10);

    for (const row of rulesRows) {
      const idx = row.body.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 100);
      const snippet = row.body.slice(start, start + Math.min(400, row.body.length - start));
      hits.push({
        source: "rules",
        space: null,
        path: `team-rules/${row.id.slice(0, 8)}`,
        title: row.title,
        snippet: idx >= 0 ? (start > 0 ? "…" : "") + snippet : row.body.slice(0, 300) + "…",
        score: idx >= 0 ? 2 : 1,
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

    const references = results
      .map((hit) => `[${hit.source}${hit.space ? `/${hit.space}` : ""}] ${hit.path ?? hit.title}`)
      .join("\n");

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
