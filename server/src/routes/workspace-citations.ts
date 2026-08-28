import { and, eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import {
  type AssetRef,
  assetHealth,
  isAssetKind,
  recordCited,
} from "../services/asset-citations.js";

/**
 * The write-back half of the workspace channel (MUL-133).
 *
 * `recall` already tells a session which assets it is looking at. These two
 * endpoints close the loop: one takes the session's declaration of what it
 * actually used, the other reads the resulting picture back out.
 */
/**
 * Ids reach the ledger's uuid columns directly, so a malformed one would come
 * back as a database syntax error dressed up as a 500. Checking the shape here
 * keeps a caller typo a caller error.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workspaceCitationsRoutes(db: Db): Router {
  const r = Router();

  /**
   * Declare which assets this session actually used.
   *
   * Accepts `rule:<uuid>` style refs so a caller can paste them straight out
   * of a recall response without reshaping anything. Re-declaring the same
   * asset on the same issue is a no-op rather than an error — a session that
   * cites twice is reporting one adoption, and making the second call fail
   * would only teach callers to skip the declaration entirely.
   */
  r.post("/companies/:companyId/workspace/citations", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const body = (req.body ?? {}) as {
      issueId?: string;
      sessionId?: string;
      assets?: Array<string | { kind?: string; id?: string; versionId?: string }>;
    };
    const rawAssets = Array.isArray(body.assets) ? body.assets : [];
    if (rawAssets.length === 0) throw badRequest("assets is required and must be a non-empty array");

    const assets: AssetRef[] = [];
    for (const entry of rawAssets) {
      const parsed = typeof entry === "string"
        ? { kind: entry.slice(0, entry.indexOf(":")), id: entry.slice(entry.indexOf(":") + 1), versionId: undefined }
        : { kind: entry.kind ?? "", id: entry.id ?? "", versionId: entry.versionId };
      if (!isAssetKind(parsed.kind)) {
        throw badRequest(`unknown asset kind in "${typeof entry === "string" ? entry : parsed.kind}" — expected rule, wiki or skill`);
      }
      if (!UUID_RE.test(parsed.id)) throw badRequest(`asset id "${parsed.id}" is not a uuid`);
      assets.push({ kind: parsed.kind, id: parsed.id, versionId: parsed.versionId ?? null });
    }

    // Check the issue before writing. Without it a card id from another
    // company, or one that no longer exists, reaches the ledger's foreign key
    // and comes back as a 500 — an unreadable answer to what is really a
    // caller mistake, and one that would leak whether an id exists elsewhere.
    if (body.issueId && !UUID_RE.test(body.issueId)) throw badRequest(`issueId "${body.issueId}" is not a uuid`);
    if (body.issueId) {
      const [issue] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, body.issueId), eq(issues.companyId, companyId)))
        .limit(1);
      if (!issue) throw notFound(`Issue ${body.issueId} not found in this company`);
    }

    const recorded = await recordCited(
      db,
      {
        companyId,
        issueId: body.issueId ?? null,
        agentId: actor.agentId,
        sessionId: body.sessionId ?? null,
      },
      assets,
    );
    res.json({ declared: assets.length, recorded, duplicates: assets.length - recorded });
  });

  /**
   * The asset health picture: served and cited counts per asset, plus the
   * dead-weight flag. Read-only on purpose — this endpoint names candidates
   * for a human to prune, it never prunes.
   */
  r.get("/companies/:companyId/workspace/assets/health", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await assetHealth(db, companyId);
    res.json({
      assets: rows,
      deadWeightCount: rows.filter((row) => row.deadWeight).length,
    });
  });

  return r;
}
