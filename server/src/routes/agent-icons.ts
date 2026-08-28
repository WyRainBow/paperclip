import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

const ALLOWED_ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]);
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

export function agentIconUploadDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "upload", "agent-icons");
}

/**
 * Local-only agent icon uploads: board/agents PUT an image, it lands in the
 * instance's upload directory and the agent's metadata.customIcon points at
 * the serving URL. No remote storage — this is deliberately local-first.
 */
export function agentIconRoutes(db: Db) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage() });

  router.post("/agents/:id/icon", async (req, res) => {
    const id = req.params.id as string;
    const agent = await db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");

    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
    });
    const file = req.file;
    if (!file) throw badRequest("file field is required");
    if (!ALLOWED_ICON_TYPES.has(file.mimetype)) {
      throw badRequest(`Unsupported icon type ${file.mimetype}; use png/jpg/webp/svg/gif`);
    }
    if (file.size > MAX_ICON_BYTES) throw badRequest("Icon exceeds 2MB");

    const dir = agentIconUploadDir();
    await mkdir(dir, { recursive: true });
    const filename = `${agent.id}-${randomUUID().slice(0, 8)}.${EXTENSION_BY_TYPE[file.mimetype]}`;
    await writeFile(path.join(dir, filename), file.buffer);

    // Replace any previous custom icon file.
    const previous = (agent.metadata as Record<string, unknown> | null)?.customIconFile as string | undefined;
    if (previous) {
      await unlink(path.join(dir, previous)).catch(() => undefined);
    }

    const metadata = {
      ...((agent.metadata as Record<string, unknown> | null) ?? {}),
      customIcon: `/api/upload/agent-icons/${filename}`,
      customIconFile: filename,
    };
    const [updated] = await db.update(agents).set({ metadata, updatedAt: new Date() }).where(eq(agents.id, id)).returning();
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.icon_uploaded",
      entityType: "agent",
      entityId: agent.id,
      details: { filename },
    });
    res.json(updated);
  });

  router.delete("/agents/:id/icon", async (req, res) => {
    const id = req.params.id as string;
    const agent = await db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    const metadata = { ...((agent.metadata as Record<string, unknown> | null) ?? {}) };
    const filename = metadata.customIconFile as string | undefined;
    delete metadata.customIcon;
    delete metadata.customIconFile;
    const [updated] = await db.update(agents).set({ metadata, updatedAt: new Date() }).where(eq(agents.id, id)).returning();
    if (filename) {
      await unlink(path.join(agentIconUploadDir(), filename)).catch(() => undefined);
    }
    res.json(updated);
  });

  return router;
}
