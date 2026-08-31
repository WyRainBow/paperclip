import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmbeddingError,
  batchLimitFor,
  dot,
  embedBatch,
  normalizeVector,
  packVector,
  unpackVector,
  type EmbeddingConfig,
} from "../services/embedding-client.js";

const config: EmbeddingConfig = {
  provider: "dashscope",
  model: "text-embedding-v4",
  apiKey: "test-key",
};

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("batch limits", () => {
  it("knows each provider's ceiling", () => {
    // Measured 2026-08-30: DashScope rejects 25 with
    // "batch size is invalid, it should not be larger than 10".
    expect(batchLimitFor("dashscope")).toBe(10);
    expect(batchLimitFor("openai")).toBeGreaterThan(10);
  });

  it("refuses an oversized batch before spending a request", async () => {
    const fetchSpy = mockFetch(() => jsonResponse({}));
    const inputs = Array.from({ length: 11 }, (_, i) => `chunk ${i}`);
    await expect(embedBatch(config, inputs)).rejects.toThrow(/exceeds the dashscope limit of 10/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns immediately for an empty batch", async () => {
    const fetchSpy = mockFetch(() => jsonResponse({}));
    await expect(embedBatch(config, [])).resolves.toEqual({ vectors: [], tokens: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("embedBatch", () => {
  it("returns one vector per input and the reported token count", async () => {
    mockFetch(() =>
      jsonResponse({
        data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
        usage: { total_tokens: 7 },
      }),
    );
    const result = await embedBatch(config, ["a", "b"]);
    expect(result.vectors).toHaveLength(2);
    expect(Array.from(result.vectors[0]!)).toEqual([1, 0, 0]);
    expect(result.tokens).toBe(7);
  });

  it("reports zero tokens when the provider omits usage", async () => {
    // text-embedding-v3 always reports 0; that means "not reported", not "free".
    mockFetch(() => jsonResponse({ data: [{ embedding: [1, 2] }] }));
    expect((await embedBatch(config, ["a"])).tokens).toBe(0);
  });

  it("marks 429 and 5xx retryable, 401 and 400 not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [401, false],
      [400, false],
    ] as const) {
      mockFetch(() => new Response("upstream said no", { status }));
      const err = await embedBatch(config, ["a"]).catch((e) => e);
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).status).toBe(status);
      expect((err as EmbeddingError).retryable).toBe(retryable);
    }
  });

  it("treats a network failure as retryable", async () => {
    mockFetch(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")));
    const err = await embedBatch(config, ["a"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).retryable).toBe(true);
    expect((err as EmbeddingError).status).toBeNull();
  });

  it("rejects a response with the wrong number of vectors", async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: [1] }] }));
    await expect(embedBatch(config, ["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("rejects an empty embedding rather than storing a zero vector", async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: [] }] }));
    await expect(embedBatch(config, ["a"])).rejects.toThrow(/came back empty/);
  });

  it("aborts on timeout and reports it as retryable", async () => {
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
    );
    const err = await embedBatch({ ...config, timeoutMs: 10 }, ["a"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).retryable).toBe(true);
  });

  it("sends the OpenAI-compatible request shape with bearer auth", async () => {
    const fetchSpy = mockFetch(() => jsonResponse({ data: [{ embedding: [1] }] }));
    await embedBatch(config, ["hello"]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("dashscope.aliyuncs.com");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "text-embedding-v4",
      input: ["hello"],
    });
  });
});

describe("vector storage round trip", () => {
  it("survives pack and unpack byte for byte", () => {
    const original = Float32Array.from([0.5, -0.25, 1e-8, 12345.678]);
    const restored = unpackVector(packVector(original));
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it("unpacks correctly from a buffer that is a view into a larger pool", () => {
    const original = Float32Array.from([1, 2, 3, 4]);
    const pool = Buffer.alloc(64);
    packVector(original).copy(pool, 16);
    const view = pool.subarray(16, 16 + original.byteLength);
    expect(Array.from(unpackVector(view))).toEqual([1, 2, 3, 4]);
  });
});

describe("similarity", () => {
  it("normalizes to unit length", () => {
    const unit = normalizeVector(Float32Array.from([3, 4]));
    expect(dot(unit, unit)).toBeCloseTo(1, 5);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    const zero = normalizeVector(Float32Array.from([0, 0]));
    expect(Array.from(zero)).toEqual([0, 0]);
  });

  it("scores identical direction at 1 and opposite at -1", () => {
    const a = normalizeVector(Float32Array.from([1, 1]));
    const same = normalizeVector(Float32Array.from([2, 2]));
    const opposite = normalizeVector(Float32Array.from([-1, -1]));
    expect(dot(a, same)).toBeCloseTo(1, 5);
    expect(dot(a, opposite)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for mismatched dimensions instead of reading past the end", () => {
    expect(dot(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toBe(0);
  });
});
