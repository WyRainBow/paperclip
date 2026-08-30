/**
 * Experience board API (MUL-133 需求三): one row per card that has been
 * friction-scored, tagged retro-owed, or sedimented.
 */
import { api } from "./client";

export interface FrictionEvidence {
  actor: string;
  at: string;
  stage: string;
  code: string;
  note?: string;
}

export interface ExperienceSelfReported {
  documents: number;
  parsed: number;
  parseErrors: number;
  totalCalls: number;
  failedCalls: number;
  failureRate: number;
  clusters: number;
  latestAt: string | null;
}

export interface ExperienceBoardRow {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  frictionTotal: number;
  frictionSignals: Array<{ key: string; count: number; points: number; evidence?: FrictionEvidence[] }>;
  retroOwed: boolean;
  sediment: { path: string; at: string } | null;
  lastScoredAt: string | null;
  updatedAt: string;
  selfReported: ExperienceSelfReported | null;
}

export interface ExperienceBoardResult {
  rows: ExperienceBoardRow[];
  retroOwedCount: number;
}

export function experienceBoardApi(companyId: string): Promise<ExperienceBoardResult | null> {
  return api.get<ExperienceBoardResult>(`/companies/${companyId}/workspace/experience/board`);
}
