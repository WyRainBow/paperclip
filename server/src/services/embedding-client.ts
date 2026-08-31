import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "embedding-client" });

/**
 * Outbound embedding client (MUL-441).
 *
 * This is the first place the Paperclip server calls a model itself. Everything
 * before it ran models in adapter subprocesses, so the server had no notion of
 * an upstream that can be slow, rate-limited, or simply absent. Every failure
 * mode here has to end in "recall still works", because the keyword leg is the
 * product and this is an addition to it.
 */

export interface EmbeddingConfig {
  provider: "dashscope" | "openai";
  model: string;
  apiKey: string;
  /** Optional override; each provider has a sane default. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface EmbeddingResult {
  vectors: Float32Array[];
  /** Tokens billed, when the provider reports them. */
  tokens: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Provider batch ceilings.
 *
 * DashScope rejects anything over 10 with
 * `<400> InternalError.Algo.InvalidParameter: batch size is invalid, it should
 * not be larger than 10` (measured 2026-08-30). Sending 25 fails the whole
 * request, not the overflow, so the cap has to be enforced on this side.
 */
const BATCH_LIMIT: Record<EmbeddingConfig["provider"], number> = {
  dashscope: 10,
  openai: 100,
};

const BASE_URL: Record<EmbeddingConfig["provider"], string> = {
  // OpenAI-compatible surface, so both providers share one request shape.
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
  openai: "https://api.openai.com/v1/embeddings",
};

export function batchLimitFor(provider: EmbeddingConfig["provider"]): number {
  return BATCH_LIMIT[provider];
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * Embeds one batch. Callers must respect `batchLimitFor`.
 *
 * Errors are classified rather than swallowed here: the caller decides whether
 * a failure means "skip the vector leg for this query" (recall) or "retry this
 * chunk later" (the reindex job), and it cannot decide that without knowing
 * whether the failure was transient.
 */
export async function embedBatch(
  config: EmbeddingConfig,
  inputs: string[],
): Promise<EmbeddingResult> {
  if (inputs.length === 0) return { vectors: [], tokens: 0 };
  const limit = batchLimitFor(config.provider);
  if (inputs.length > limit) {
    throw new EmbeddingError(
      `batch of ${inputs.length} exceeds the ${config.provider} limit of ${limit}`,
      null,
      false,
    );
  }

  const url = config.baseUrl ?? BASE_URL[config.provider];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
      signal: controller.signal,
    });
  } catch (err) {
    // Offline, DNS failure, or our own timeout. All transient by nature.
    const reason = err instanceof Error ? err.message : String(err);
    throw new EmbeddingError(`embedding request failed: ${reason}`, null, true);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 429 and 5xx are worth another attempt; 401 and 400 will fail identically
    // forever and should stop the job rather than spin it.
    const retryable = response.status === 429 || response.status >= 500;
    throw new EmbeddingError(
      `embedding provider returned ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      retryable,
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { total_tokens?: number };
    error?: unknown;
  };
  if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) {
    throw new EmbeddingError(
      `embedding provider returned ${payload.data?.length ?? 0} vectors for ${inputs.length} inputs`,
      response.status,
      false,
    );
  }

  const vectors = payload.data.map((entry, index) => {
    const values = entry.embedding;
    if (!Array.isArray(values) || values.length === 0) {
      throw new EmbeddingError(`embedding ${index} came back empty`, response.status, false);
    }
    return Float32Array.from(values);
  });

  // DashScope's text-embedding-v3 always reports 0 tokens while v4 reports real
  // ones (measured 2026-08-30), so a zero here means "not reported", not "free".
  return { vectors, tokens: payload.usage?.total_tokens ?? 0 };
}

/** Packs a vector for the `bytea` column. */
export function packVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Unpacks a `bytea` column back into a vector. */
export function unpackVector(buffer: Buffer): Float32Array {
  // Buffer may be a view into a larger pool, so copy rather than reinterpret.
  const copy = Buffer.from(buffer);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** Scales a vector to unit length so cosine similarity becomes a dot product. */
export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / magnitude;
  return out;
}

/** Dot product of two unit vectors, i.e. their cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function logEmbeddingFailure(scope: string, err: unknown): void {
  if (err instanceof EmbeddingError) {
    log.warn({ status: err.status, retryable: err.retryable }, `${scope}: ${err.message}`);
    return;
  }
  log.warn({ err }, `${scope}: ${err instanceof Error ? err.message : String(err)}`);
}
