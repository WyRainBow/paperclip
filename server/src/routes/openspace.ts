import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { openspaceNotes } from "@paperclipai/db";
import { assertCompanyAccess, assertBoardOrAgent } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

/**
 * Openspace: the company-level shared context surface. Notes are openspace's
 * only owned storage; skills and the wiki are referenced, never copied —
 * `GET /openspace/overview` groups company skills by origin so the tab can
 * show "openspace skills vs plugin-shipped" without touching the skills store.
 */
export function openspaceRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/openspace/notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const notes = await db
      .select()
      .from(openspaceNotes)
      .where(eq(openspaceNotes.companyId, companyId))
      .orderBy(asc(openspaceNotes.position), asc(openspaceNotes.createdAt));
    res.json(notes);
  });

  router.post("/companies/:companyId/openspace/notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) throw badRequest("title is required");
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    const position = typeof req.body?.position === "number" ? req.body.position : 0;
    const actor = getActorInfo(req);
    const [created] = await db
      .insert(openspaceNotes)
      .values({
        companyId,
        title: title.slice(0, 200),
        body,
        position,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.actorType === "agent" ? (actor.agentId ?? null) : null,
      })
      .returning();
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "openspace.note_created",
      entityType: "openspace_note",
      entityId: created.id,
      details: { title: created.title },
    });
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/openspace/notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 200);
    if (typeof req.body?.body === "string") patch.body = req.body.body;
    if (typeof req.body?.position === "number") patch.position = req.body.position;
    const [updated] = await db
      .update(openspaceNotes)
      .set(patch)
      .where(and(eq(openspaceNotes.id, noteId), eq(openspaceNotes.companyId, companyId)))
      .returning();
    if (!updated) throw notFound("Note not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "openspace.note_updated",
      entityType: "openspace_note",
      entityId: updated.id,
      details: { title: updated.title },
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/openspace/notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const [deleted] = await db
      .delete(openspaceNotes)
      .where(and(eq(openspaceNotes.id, noteId), eq(openspaceNotes.companyId, companyId)))
      .returning();
    if (!deleted) throw notFound("Note not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "openspace.note_deleted",
      entityType: "openspace_note",
      entityId: deleted.id,
      details: { title: deleted.title },
    });
    res.json(deleted);
  });

  return router;
}
