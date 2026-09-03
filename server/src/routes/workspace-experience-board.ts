import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { experienceBoardRows } from "../services/retro-gate.js";

/**
 * The experience board (MUL-133 需求三): one row per card that has been
 * friction-scored, tagged retro-owed, or sedimented — the boss's "which tasks
 * deserve a second look" surface. Read-only.
 */
export function workspaceExperienceBoardRoutes(db: Db): Router {
  const r = Router();

  r.get("/companies/:companyId/workspace/experience/board", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await experienceBoardRows(db, companyId);
    res.json({ rows, retroOwedCount: rows.filter((row) => row.retroOwed).length });
  });

  return r;
}
