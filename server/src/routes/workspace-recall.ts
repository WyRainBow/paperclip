import { and, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamWikiPages, teamRuleNotes } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

const DEFAULT_BUDGET_CHARS = 2000;
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
      const wikiPages = await db
        .select({ space: teamWikiPages.space, path: teamWikiPages.path, title: teamWikiPages.title })
        .from(teamWikiPages)
        .where(eq(teamWikiPages.companyId, companyId))
        .limit(100);
      const ruleNotes = await db
        .select({ title: teamRuleNotes.title })
        .from(teamRuleNotes)
        .where(eq(teamRuleNotes.companyId, companyId))
        .limit(20);

      const lines: string[] = [];
      lines.push("=== TeamWorkSpace 资产目录 ===");
      if (ruleNotes.length > 0) {
        lines.push("Team Rules:");
        for (const note of ruleNotes) lines.push(`  - ${note.title}`);
      }
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
      const truncated = mapText.length > budget ? mapText.slice(0, budget) + "…(截断)" : mapText;
      res.json({ mode: "directory", text: truncated, budgetChars: budget, usedChars: truncated.length });
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

  return r;
}
