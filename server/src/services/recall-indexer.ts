import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { recallEmbeddings } from "@paperclipai/db";

import { logger } from "../middleware/logger.js";
import {
  EmbeddingError,
  batchLimitFor,
  embedBatch,
  logEmbeddingFailure,
  normalizeVector,
  packVector,
  type EmbeddingConfig,
} from "./embedding-client.js";
import { fetchSourceRows, type SourceRow } from "./recall-corpus.js";
import { chunkBody } from "./recall-ranking.js";
import { invalidateSemanticCache } from "./recall-semantic.js";

const log = logger.child({ service: "recall-indexer" });

/**
 * Builds and refreshes the vector index (MUL-441).
 *
 * Incremental by content hash: a chunk whose text has not changed is not
 * re-embedded. That is what keeps this affordable to run on a schedule — the
 * first pass over the real wiki cost 31653 tokens and 18 seconds, and every
 * pass after it costs whatever actually changed, which on a normal day is a
 * handful of chunks.
 */

export interface IndexResult {
  scannedChunks: number;
  embeddedChunks: number;
  deletedRows: number;
  tokens: number;
  /** Set when the run stopped early; the index is left partially updated. */
  stoppedBecause?: string;
}

/** How much of the corpus one pass may embed, so a first run cannot bill unbounded. */
const DEFAULT_MAX_CHUNKS_PER_RUN = 2000;

function hashChunk(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

interface PendingChunk {
  row: SourceRow;
  chunkIndex: number;
  chunkOffset: number;
  text: string;
  hash: string;
}

/** Title is prepended so a chunk carries the context its own text may omit. */
function embeddingText(row: SourceRow, text: string): string {
  return `${row.title}\n${text}`;
}

export async function reindexCompany(
  db: Db,
  companyId: string,
  config: EmbeddingConfig,
  options: { maxChunks?: number } = {},
): Promise<IndexResult> {
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS_PER_RUN;
  const result: IndexResult = {
    scannedChunks: 0,
    embeddedChunks: 0,
    deletedRows: 0,
    tokens: 0,
  };

  // The whole corpus, by the same definition recall searches. A limit high
  // enough to mean "everything" at this scale, and a bound rather than none so
  // a runaway table cannot pull the process over.
  const rows = await fetchSourceRows(db, companyId, { limitPerSource: 5000 });

  const pending: PendingChunk[] = [];
  for (const row of rows) {
    if (row.body.trim().length === 0) continue;
    chunkBody(row.body).forEach((chunk, chunkIndex) => {
      if (chunk.text.trim().length === 0) return;
      pending.push({
        row,
        chunkIndex,
        chunkOffset: chunk.offset,
        text: chunk.text,
        hash: hashChunk(embeddingText(row, chunk.text)),
      });
    });
  }
  result.scannedChunks = pending.length;

  const existing = await db
    .select({
      id: recallEmbeddings.id,
      sourceKind: recallEmbeddings.sourceKind,
      sourceId: recallEmbeddings.sourceId,
      chunkIndex: recallEmbeddings.chunkIndex,
      contentHash: recallEmbeddings.contentHash,
    })
    .from(recallEmbeddings)
    .where(and(eq(recallEmbeddings.companyId, companyId), eq(recallEmbeddings.model, config.model)));

  const existingByKey = new Map(
    existing.map((row) => [`${row.sourceKind}:${row.sourceId}:${row.chunkIndex}`, row]),
  );

  const stale = pending.filter((chunk) => {
    const key = `${chunk.row.sourceKind}:${chunk.row.sourceId}:${chunk.chunkIndex}`;
    return existingByKey.get(key)?.contentHash !== chunk.hash;
  });

  // Rows whose chunk no longer exists: the source shrank, was re-split, or was
  // deleted outright. Left in place they would serve text that is no longer
  // anywhere in the document.
  const liveKeys = new Set(
    pending.map((chunk) => `${chunk.row.sourceKind}:${chunk.row.sourceId}:${chunk.chunkIndex}`),
  );
  const orphanIds = existing
    .filter((row) => !liveKeys.has(`${row.sourceKind}:${row.sourceId}:${row.chunkIndex}`))
    .map((row) => row.id);
  if (orphanIds.length > 0) {
    // Chunked so a large cleanup cannot build an unbounded IN list.
    for (let i = 0; i < orphanIds.length; i += 500) {
      await db.delete(recallEmbeddings).where(inArray(recallEmbeddings.id, orphanIds.slice(i, i + 500)));
    }
    result.deletedRows = orphanIds.length;
  }

  const batchSize = batchLimitFor(config.provider);
  const todo = stale.slice(0, maxChunks);
  if (stale.length > maxChunks) {
    result.stoppedBecause = `capped at ${maxChunks} chunks; ${stale.length - maxChunks} still stale`;
  }

  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    let vectors: Float32Array[];
    try {
      const response = await embedBatch(
        config,
        batch.map((chunk) => embeddingText(chunk.row, chunk.text)),
      );
      vectors = response.vectors;
      result.tokens += response.tokens;
    } catch (err) {
      logEmbeddingFailure("recall indexer", err);
      // A retryable failure means try again next run; a permanent one (bad key,
      // bad model) will fail identically on every remaining batch, so stopping
      // is the difference between one wasted call and hundreds.
      result.stoppedBecause =
        err instanceof EmbeddingError && err.retryable
          ? "upstream temporarily unavailable"
          : "upstream rejected the request";
      break;
    }

    // Vectors are normalized once here so every query-time scan is a plain dot
    // product rather than a cosine division per row.
    const values = batch.map((chunk, index) => ({
      companyId,
      sourceKind: chunk.row.sourceKind,
      sourceId: chunk.row.sourceId,
      chunkIndex: chunk.chunkIndex,
      chunkOffset: chunk.chunkOffset,
      contentHash: chunk.hash,
      model: config.model,
      dim: vectors[index]!.length,
      vector: packVector(normalizeVector(vectors[index]!)),
      updatedAt: new Date(),
    }));

    await db
      .insert(recallEmbeddings)
      .values(values)
      .onConflictDoUpdate({
        target: [
          recallEmbeddings.companyId,
          recallEmbeddings.model,
          recallEmbeddings.sourceKind,
          recallEmbeddings.sourceId,
          recallEmbeddings.chunkIndex,
        ],
        set: {
          chunkOffset: sqlExcluded("chunk_offset"),
          contentHash: sqlExcluded("content_hash"),
          dim: sqlExcluded("dim"),
          vector: sqlExcluded("vector"),
          updatedAt: new Date(),
        },
      });

    result.embeddedChunks += batch.length;
  }

  if (result.embeddedChunks > 0 || result.deletedRows > 0) invalidateSemanticCache(companyId);

  log.info(
    {
      companyId,
      model: config.model,
      ...result,
    },
    "recall index refreshed",
  );
  return result;
}

/** `excluded.<column>` for an upsert's SET clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded."${column}"`);
}
