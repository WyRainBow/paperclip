import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personalFileVersions, personalFiles } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const KINDS = new Set(["claude-md", "agents-md", "workspace-agents"]);

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function actorUserId(req: Request): string {
  return req.actor.type === "board" ? (req.actor.userId ?? "local-board") : "local-board";
}

/**
 * Version management for personal directive files (global CLAUDE.md /
 * AGENTS.md and per-repo variants). The filesystem stays the source of
 * truth; this API registers files and snapshots content on sync — a
 * check-in model (MUL-39 tech-proposal). Rollback is export-only: the
 * API never writes content back to any file.
 */
export function personalFileRoutes(db: Db): Router {
  const r = Router();

  r.get("/companies/:companyId/personal-files", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = (req.query.userId as string | undefined) ?? actorUserId(req);
    const rows = await db
      .select()
      .from(personalFiles)
      .where(and(eq(personalFiles.companyId, companyId), eq(personalFiles.userId, userId)))
      .orderBy(asc(personalFiles.path));
    res.json(rows);
  });

  r.post("/companies/:companyId/personal-files", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = (req.body?.userId as string | undefined) ?? actorUserId(req);
    const kind = req.body?.kind as string | undefined;
    const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!kind || !KINDS.has(kind)) throw badRequest(`kind must be one of ${[...KINDS].join("/")}`);
    if (!path) throw badRequest("path is required");
    const [row] = await db
      .insert(personalFiles)
      .values({ companyId, userId, kind, path })
      .onConflictDoNothing()
      .returning();
    if (row) {
      res.status(201).json(row);
      return;
    }
    const [existing] = await db
      .select()
      .from(personalFiles)
      .where(and(eq(personalFiles.companyId, companyId), eq(personalFiles.userId, userId), eq(personalFiles.path, path)))
      .limit(1);
    res.status(200).json(existing);
  });

  /** Check-in: snapshot current content. No-op when the hash is unchanged. */
  r.post("/companies/:companyId/personal-files/:fileId/sync", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const fileId = req.params.fileId as string;
    assertCompanyAccess(req, companyId);
    const content = typeof req.body?.content === "string" ? req.body.content : null;
    if (content === null) throw badRequest("content is required");
    const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 200) : null;
    const [file] = await db
      .select()
      .from(personalFiles)
      .where(and(eq(personalFiles.id, fileId), eq(personalFiles.companyId, companyId)))
      .limit(1);
    if (!file) throw notFound("Personal file not found");
    const hash = hashContent(content);
    if (hash === file.currentHash) {
      const versions = await db
        .select({ id: personalFileVersions.id, revisionNumber: personalFileVersions.revisionNumber })
        .from(personalFileVersions)
        .where(eq(personalFileVersions.fileId, fileId))
        .orderBy(desc(personalFileVersions.revisionNumber))
        .limit(1);
      res.json({ unchanged: true, revisionNumber: versions[0]?.revisionNumber ?? 0 });
      return;
    }
    const [latest] = await db
      .select({ revisionNumber: personalFileVersions.revisionNumber })
      .from(personalFileVersions)
      .where(eq(personalFileVersions.fileId, fileId))
      .orderBy(desc(personalFileVersions.revisionNumber))
      .limit(1);
    const nextRevision = (latest?.revisionNumber ?? 0) + 1;
    const [version] = await db
      .insert(personalFileVersions)
      .values({ fileId, revisionNumber: nextRevision, content, contentHash: hash, label, createdByUserId: actorUserId(req) })
      .returning();
    const [updated] = await db
      .update(personalFiles)
      .set({ currentHash: hash, updatedAt: new Date() })
      .where(eq(personalFiles.id, fileId))
      .returning();
    res.status(201).json({ unchanged: false, revisionNumber: version.revisionNumber, file: updated });
  });

  r.get("/companies/:companyId/personal-files/:fileId/versions", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const fileId = req.params.fileId as string;
    assertCompanyAccess(req, companyId);
    const rows = await db
      .select({
        id: personalFileVersions.id,
        revisionNumber: personalFileVersions.revisionNumber,
        contentHash: personalFileVersions.contentHash,
        label: personalFileVersions.label,
        createdByUserId: personalFileVersions.createdByUserId,
        createdAt: personalFileVersions.createdAt,
      })
      .from(personalFileVersions)
      .where(eq(personalFileVersions.fileId, fileId))
      .orderBy(desc(personalFileVersions.revisionNumber));
    res.json(rows);
  });

  /** Version content for viewing or export; writing it back to the file is a manual step. */
  r.get("/companies/:companyId/personal-files/:fileId/versions/:revisionNumber", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const fileId = req.params.fileId as string;
    assertCompanyAccess(req, companyId);
    const revisionNumber = Number.parseInt(req.params.revisionNumber as string, 10);
    if (!Number.isInteger(revisionNumber)) throw badRequest("revisionNumber must be an integer");
    const [row] = await db
      .select()
      .from(personalFileVersions)
      .where(and(eq(personalFileVersions.fileId, fileId), eq(personalFileVersions.revisionNumber, revisionNumber)))
      .limit(1);
    if (!row) throw notFound("Version not found");
    res.json(row);
  });

  return r;
}
