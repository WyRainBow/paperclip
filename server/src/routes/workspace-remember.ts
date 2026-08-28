import { and, eq, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { issues, teamWikiPages, teamWikiPageVersions } from "@paperclipai/db";
import { assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

/**
 * `workspace remember` — the agent-initiated half of the experience loop
 * (MUL-133, borrowed from OpenViking's `remember` tool).
 *
 * OV has no friction detection at all; its experience pipeline runs purely on
 * the agent choosing to write. That model is worth copying precisely because
 * it is the complement of our close-out gate (件三): the gate says WHEN a
 * card probably owes a lesson, remember is HOW a lesson gets in at the
 * moment the agent sees it — no human gate on the write path, because the
 * landing zone is a versioned wiki page a person can prune or veto after
 * the fact.
 *
 * What is copied from OV's `experiences` memory template (the shape, not the
 * code — OV is AGPLv3):
 * - the fixed three-section body: Situation (entry conditions) / Approach
 *   (imperative DOs) / Reflect (hard DON'Ts), written as machine instructions
 *   so the page can be injected into a future system prompt as-is
 * - one experience per page, keyed by name: remembering again with the same
 *   title UPDATES that page (OV upserts by filename; we pin a new revision on
 *   the same wiki page, which keeps history OV throws away)
 * - a `supersedes` pointer for evolution across names: OV auto-deletes the
 *   old experience; we deliberately keep it and only record the pointer,
 *   because deletion is a human call here
 *
 * Pages land in the `agent` space under `cases/`, which recall already
 * searches — a remembered experience is served to the very next session.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TITLE_CHARS = 60;

function slugSegment(title: string): string {
  // The title is the stable key of the experience, so the slug keeps the
  // title verbatim minus characters that break paths. CJK survives as-is;
  // the unique index treats `cases/<slug>` as the identity.
  const slug = title
    .trim()
    .replace(/[/\\]+/g, "·")
    .replace(/\s+/g, "-");
  if (!slug) throw badRequest("title is required");
  if (slug === "." || slug === "..") throw badRequest("title must not be a path segment");
  return slug.slice(0, 80);
}

function composeExperienceBody(input: {
  situation: string;
  approach: string;
  reflect: string;
  issueId: string | null;
  supersedesPath: string | null;
  authorLabel: string;
}): string {
  const lines: string[] = [
    "## Situation",
    input.situation.trim(),
    "",
    "## Approach",
    input.approach.trim(),
    "",
    "## Reflect",
    input.reflect.trim(),
    "",
    "---",
    `- 记录者：${input.authorLabel}`,
    `- 记录时间：${new Date().toISOString()}`,
  ];
  if (input.issueId) lines.push(`- 来源卡：${input.issueId}（翻卡可核对当时的事实）`);
  if (input.supersedesPath) lines.push(`- 取代：${input.supersedesPath}（旧页保留，本页为其后续）`);
  return lines.join("\n");
}

export function workspaceRememberRoutes(db: Db): Router {
  const r = Router();

  r.post("/companies/:companyId/workspace/remember", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const actor = getActorInfo(req);

    const body = (req.body ?? {}) as {
      title?: unknown;
      situation?: unknown;
      approach?: unknown;
      reflect?: unknown;
      issueId?: unknown;
      supersedesPath?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "";
    if (!title) throw badRequest("title is required — name the generalizable pattern, not the incident");
    const situation = typeof body.situation === "string" ? body.situation.trim() : "";
    const approach = typeof body.approach === "string" ? body.approach.trim() : "";
    const reflect = typeof body.reflect === "string" ? body.reflect.trim() : "";
    if (!situation) throw badRequest("situation is required — the entry conditions that make this pattern apply");
    if (!approach) throw badRequest("approach is required — the imperative DOs, the optimized execution path");
    if (!reflect) throw badRequest("reflect is required — the hard DON'Ts and boundary conditions");

    let issueId: string | null = null;
    if (typeof body.issueId === "string" && body.issueId.trim()) {
      if (!UUID_RE.test(body.issueId)) throw badRequest(`issueId "${body.issueId}" is not a uuid`);
      const [issue] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, body.issueId), eq(issues.companyId, companyId)))
        .limit(1);
      if (!issue) throw notFound(`Issue ${body.issueId} not found in this company`);
      issueId = issue.id;
    }

    let supersedesPath: string | null = null;
    if (typeof body.supersedesPath === "string" && body.supersedesPath.trim()) {
      supersedesPath = body.supersedesPath.trim();
      const [superseded] = await db
        .select({ id: teamWikiPages.id })
        .from(teamWikiPages)
        .where(and(
          eq(teamWikiPages.companyId, companyId),
          eq(teamWikiPages.space, "agent"),
          eq(teamWikiPages.path, supersedesPath),
        ))
        .limit(1);
      if (!superseded) throw notFound(`supersedesPath "${supersedesPath}" has no agent-space page`);
    }

    const path = `cases/${slugSegment(title)}`;
    const pageBody = composeExperienceBody({
      situation,
      approach,
      reflect,
      issueId,
      supersedesPath,
      authorLabel: actor.actorType === "agent" ? `agent ${actor.agentId ?? actor.actorId}` : `user ${actor.actorId}`,
    });

    const existing = await db
      .select({
        id: teamWikiPages.id,
        path: teamWikiPages.path,
        title: teamWikiPages.title,
        body: teamWikiPages.body,
      })
      .from(teamWikiPages)
      .where(and(
        eq(teamWikiPages.companyId, companyId),
        eq(teamWikiPages.space, "agent"),
        eq(teamWikiPages.path, path),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      const [created] = await db
        .insert(teamWikiPages)
        .values({
          companyId,
          space: "agent",
          path,
          title,
          body: pageBody,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdByAgentId: actor.actorType === "agent" ? (actor.agentId ?? null) : null,
        })
        .returning();
      const [version] = await db
        .insert(teamWikiPageVersions)
        .values({
          companyId,
          pageId: created.id,
          revisionNumber: sql<number>`(
            select coalesce(max(${teamWikiPageVersions.revisionNumber}), 0) + 1
            from ${teamWikiPageVersions}
            where ${teamWikiPageVersions.pageId} = ${created.id}
          )`,
          path,
          title,
          body: pageBody,
          label: "remember: initial",
          authorUserId: actor.actorType === "user" ? actor.actorId : null,
          authorAgentId: actor.actorType === "agent" ? (actor.agentId ?? null) : null,
        })
        .returning();
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "workspace.experience_remembered",
        entityType: "team_wiki_page",
        entityId: created.id,
        issueId,
        details: { space: "agent", path, title, revisionNumber: version.revisionNumber, created: true, ...(issueId ? { issueId } : {}) },
      });
      res.status(201).json({
        pageId: created.id,
        path,
        space: "agent",
        title,
        revisionNumber: version.revisionNumber,
        created: true,
        assetRef: `wiki:${created.id}`,
        note: "已落 agent/cases，recall 即刻可召回",
      });
      return;
    }

    const [updated] = await db
      .update(teamWikiPages)
      .set({ title, body: pageBody, updatedAt: new Date() })
      .where(and(eq(teamWikiPages.id, existing.id), eq(teamWikiPages.companyId, companyId)))
      .returning();
    const [version] = await db
      .insert(teamWikiPageVersions)
      .values({
        companyId,
        pageId: existing.id,
        revisionNumber: sql<number>`(
          select coalesce(max(${teamWikiPageVersions.revisionNumber}), 0) + 1
          from ${teamWikiPageVersions}
          where ${teamWikiPageVersions.pageId} = ${existing.id}
        )`,
        path,
        title,
        body: pageBody,
        label: "remember: refined",
        authorUserId: actor.actorType === "user" ? actor.actorId : null,
        authorAgentId: actor.actorType === "agent" ? (actor.agentId ?? null) : null,
      })
      .returning();
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workspace.experience_remembered",
      entityType: "team_wiki_page",
      entityId: existing.id,
      issueId,
      details: { space: "agent", path, title, revisionNumber: version.revisionNumber, created: false, ...(issueId ? { issueId } : {}) },
    });
    res.json({
      pageId: updated.id,
      path,
      space: "agent",
      title,
      revisionNumber: version.revisionNumber,
      created: false,
      assetRef: `wiki:${updated.id}`,
      note: "同名经验已存在，本页追加了新版本——旧版本在版本链里可回看",
    });
  });

  return r;
}
