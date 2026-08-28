/**
 * Experience board API (MUL-133 需求三): one row per card that has been
 * friction-scored, tagged retro-owed, or sedimented.
 */
import { api } from "./client";

export interface ExperienceBoardRow {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  frictionTotal: number;
  frictionSignals: Array<{ key: string; count: number; points: number }>;
  retroOwed: boolean;
  sediment: { path: string; at: string } | null;
  lastScoredAt: string | null;
  updatedAt: string;
}

export interface ExperienceBoardResult {
  rows: ExperienceBoardRow[];
  retroOwedCount: number;
}

export function experienceBoardApi(companyId: string): Promise<ExperienceBoardResult | null> {
  return api.get<ExperienceBoardResult>(`/api/companies/${companyId}/workspace/experience/board`);
}
