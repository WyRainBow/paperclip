import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { recallEmbeddings } from "@paperclipai/db";

import {
  dot,
  embedBatch,
  logEmbeddingFailure,
  normalizeVector,
  unpackVector,
  type EmbeddingConfig,
} from "./embedding-client.js";

/**
 * The semantic leg of recall (MUL-441): query embedding plus a brute-force scan
 * of this company's vectors.
 *
 * Brute force rather than an index, deliberately. Measured 2026-08-30 on the
 * real corpus: 285 chunks at 1024 dimensions scan in 0.5 ms, and the whole
 * company extrapolates to about 5 ms. pgvector would buy nothing here and would
 * cost the zero-config embedded-postgres install, which ships no `vector`
 * extension.
 */

export interface SemanticHit {
  sourceKind: string;
  sourceId: string;
  chunkIndex: number;
  chunkOffset: number;
  /** Cosine similarity, -1..1. */
  similarity: number;
}

/**
 * Similarity floor.
 *
 * Set from measurement rather than taste. On the real wiki corpus, questions
 * with a right answer scored 0.60 and up, weak relations sat around 0.50, and a
 * question the corpus had no answer for topped out at 0.40. Below this line the
 * vector leg is guessing, and a confident wrong answer is worse for a session
 * than an empty one.
 *
 * This number is calibrated per embedding model. Changing the model means
 * re-measuring it.
 */
export const MIN_SIMILARITY = 0.5;

interface CacheEntry {
  loadedAt: number;
  rows: Array<{
    sourceKind: string;
    sourceId: string;
    chunkIndex: number;
    chunkOffset: number;
    vector: Float32Array;
  }>;
}

/**
 * Vectors held in memory, keyed by company and model.
 *
 * The whole point of storing plain bytea is that the scan happens here, so the
 * vectors have to be here. At 12 MB for a full company this is a rounding error
 * against the process, and the TTL keeps a long-running server from serving
 * results built on an index the reindex job has since replaced.
 */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function invalidateSemanticCache(companyId?: string): void {
  if (!companyId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${companyId}:`)) cache.delete(key);
  }
}

async function loadVectors(db: Db, companyId: string, model: string): Promise<CacheEntry> {
  const key = `${companyId}:${model}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  const rows = await db
    .select({
      sourceKind: recallEmbeddings.sourceKind,
      sourceId: recallEmbeddings.sourceId,
      chunkIndex: recallEmbeddings.chunkIndex,
      chunkOffset: recallEmbeddings.chunkOffset,
      vector: recallEmbeddings.vector,
    })
    .from(recallEmbeddings)
    .where(and(eq(recallEmbeddings.companyId, companyId), eq(recallEmbeddings.model, model)));

  const entry: CacheEntry = {
    loadedAt: Date.now(),
    // Stored vectors are pre-normalized at write time, so the scan is a plain
    // dot product. Normalizing again here would be wasted work on every load.
    rows: rows.map((row) => ({
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      chunkIndex: row.chunkIndex,
      chunkOffset: row.chunkOffset,
      vector: unpackVector(row.vector),
    })),
  };
  cache.set(key, entry);
  return entry;
}

/**
 * Returns the semantically closest chunks, or an empty array.
 *
 * Empty covers every failure: no index built yet, provider down, rate limited,
 * key revoked. The caller cannot tell those apart and should not try — recall's
 * keyword leg answers the query either way, and a 500 here would take down a
 * feature that works in order to report that an addition to it does not.
 */
export async function semanticSearch(
  db: Db,
  companyId: string,
  config: EmbeddingConfig,
  query: string,
  limit: number,
): Promise<SemanticHit[]> {
  let index: CacheEntry;
  try {
    index = await loadVectors(db, companyId, config.model);
  } catch (err) {
    logEmbeddingFailure("semantic recall: loading vectors failed", err);
    return [];
  }
  if (index.rows.length === 0) return [];

  let queryVector: Float32Array;
  try {
    const { vectors } = await embedBatch(config, [query]);
    if (vectors.length === 0) return [];
    queryVector = normalizeVector(vectors[0]!);
  } catch (err) {
    logEmbeddingFailure("semantic recall: embedding the query failed", err);
    return [];
  }

  const scored: SemanticHit[] = [];
  for (const row of index.rows) {
    const similarity = dot(queryVector, row.vector);
    if (similarity < MIN_SIMILARITY) continue;
    scored.push({
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      chunkIndex: row.chunkIndex,
      chunkOffset: row.chunkOffset,
      similarity,
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}
