import { beforeEach, describe, expect, it } from "vitest";

import {
  recentPoorRecallQueries,
  recordRecallQuery,
  recordServed,
} from "../services/asset-citations.js";

/**
 * Both writers go through drizzle's insert builder, so a fake that records what
 * it was handed pins the contract: which table, which columns, and — the part
 * that matters most — that a failure never escapes. These run on the path of
 * every session start.
 */
function fakeDb() {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  let failNext = false;
  let reason = "";
  return {
    inserts,
    failWith(message: string) {
      failNext = true;
      reason = message;
    },
    insert(table: unknown) {
      return {
        values: async (values: unknown) => {
          if (failNext) {
            failNext = false;
            throw new Error(reason || "insert failed");
          }
          inserts.push({ table, values });
        },
      };
    },
  };
}

const actor = {
  companyId: "company-1",
  issueId: "issue-1",
  agentId: "agent-1",
  sessionId: "session-1",
};

const hit = { termCount: 5, candidateCount: 30, semanticUsed: true, resultCount: 8 };
const miss = { termCount: 4, candidateCount: 0, semanticUsed: true, resultCount: 0 };

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
});

describe("recordRecallQuery", () => {
  it("records a search that found nothing, with all three diagnostics", async () => {
    const ok = await recordRecallQuery(db as never, actor, "误删的卡怎么恢复", miss);
    expect(ok).toBe(true);
    expect(db.inserts[0]!.values).toMatchObject({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sessionId: "session-1",
      query: "误删的卡怎么恢复",
      termCount: 4,
      candidateCount: 0,
      semanticUsed: true,
      resultCount: 0,
    });
  });

  it("records a search that succeeded too", async () => {
    // Recording only the empty ones missed the common case: measured on the
    // real corpus, questions built to have no answer still returned results.
    await recordRecallQuery(db as never, actor, "分支名要按什么格式起", {
      ...hit,
      topScore: 1.42,
      topCoverage: 0.61,
    });
    expect(db.inserts[0]!.values).toMatchObject({
      resultCount: 8,
      topScore: 1.42,
      topCoverage: 0.61,
    });
  });

  it("stores null scores when there were no results to score", async () => {
    await recordRecallQuery(db as never, actor, "q", miss);
    expect(db.inserts[0]!.values).toMatchObject({ topScore: null, topCoverage: null });
  });

  it("stores how many terms survived pruning, separately from how many were produced", async () => {
    // The pair is what separates noise from a real answer. Measured on the real
    // corpus: a question the corpus knows nothing about scored coverage 1.000
    // because pruning left it one generic bigram that matched perfectly, while
    // a question with a good answer scored 0.309. Coverage alone reads backwards.
    await recordRecallQuery(db as never, actor, "宇宙背景辐射的各向异性怎么测", {
      termCount: 12,
      scoringTermCount: 1,
      candidateCount: 160,
      semanticUsed: false,
      resultCount: 8,
      topScore: 1.5,
      topCoverage: 1,
    });
    expect(db.inserts[0]!.values).toMatchObject({ termCount: 12, scoringTermCount: 1 });
  });

  it("leaves scoringTermCount null when the caller does not supply it", async () => {
    await recordRecallQuery(db as never, actor, "q", miss);
    expect(db.inserts[0]!.values).toMatchObject({ scoringTermCount: null });
  });

  it("judges nothing: a low score is stored, not filtered out", async () => {
    // The threshold for "this was only noise" is deliberately not in the write
    // path. It needs a distribution that does not exist yet, so the facts go in
    // and the line gets drawn later against real data.
    await recordRecallQuery(db as never, actor, "q", { ...hit, topScore: 0.02, topCoverage: 0.01 });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.values).toMatchObject({ topScore: 0.02 });
  });

  it("keeps attribution columns null rather than inventing values", async () => {
    await recordRecallQuery(db as never, { companyId: "company-1" }, "q", miss);
    expect(db.inserts[0]!.values).toMatchObject({
      issueId: null,
      agentId: null,
      sessionId: null,
    });
  });

  it("records termCount 0 as a real reading, not as missing data", async () => {
    // Zero is the most informative value there is: the tokenizer ate the query,
    // so the corpus is not what failed.
    await recordRecallQuery(db as never, actor, "?!", {
      termCount: 0,
      candidateCount: 0,
      semanticUsed: false,
      resultCount: 0,
    });
    expect(db.inserts[0]!.values).toMatchObject({ termCount: 0, semanticUsed: false });
  });

  it("never throws when the insert fails", async () => {
    db.failWith("connection reset");
    await expect(recordRecallQuery(db as never, actor, "q", miss)).resolves.toBe(false);
    expect(db.inserts).toHaveLength(0);
  });

  it("skips an empty query instead of storing a blank row", async () => {
    expect(await recordRecallQuery(db as never, actor, "   ", miss)).toBe(false);
    expect(db.inserts).toHaveLength(0);
  });
});

describe("recordServed is unchanged", () => {
  it("still writes nothing when there are no hits", async () => {
    // The citation ledger pairs served with cited so the two can be divided.
    // A search with no hits is neither, which is why it got its own table.
    expect(await recordServed(db as never, actor, "q", [])).toBe(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("still writes one row per hit", async () => {
    const written = await recordServed(db as never, actor, "q", [
      { kind: "wiki", id: "11111111-1111-1111-1111-111111111111", score: 2 },
      { kind: "rule", id: "22222222-2222-2222-2222-222222222222", score: 1 },
    ]);
    expect(written).toBe(2);
    expect(db.inserts[0]!.values as unknown[]).toHaveLength(2);
  });

  it("never throws when the insert fails", async () => {
    db.failWith("connection reset");
    await expect(
      recordServed(db as never, actor, "q", [
        { kind: "wiki", id: "11111111-1111-1111-1111-111111111111" },
      ]),
    ).resolves.toBe(0);
  });
});

describe("recentPoorRecallQueries", () => {
  /** Minimal drizzle-shaped query builder returning a fixed row set. */
  function readDb(rows: unknown[]) {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => rows,
    };
    return { select: () => chain };
  }

  const row = (over: Record<string, unknown>) => ({
    query: "q",
    termCount: 8,
    scoringTermCount: 6,
    candidateCount: 100,
    semanticUsed: false,
    resultCount: 8,
    topScore: 0.9,
    topCoverage: 0.4,
    sessionId: null,
    createdAt: new Date(),
    agentName: "Claude（Terminal）",
    ...over,
  });

  it("keeps a search that returned nothing", async () => {
    const out = await recentPoorRecallQueries(
      readDb([row({ resultCount: 0, topScore: null })]) as never,
      "company-1",
    );
    expect(out).toHaveLength(1);
  });

  it("keeps a search the corpus barely understood, even with a full result set", async () => {
    // The case measured on the real corpus: eight results and a perfect
    // coverage score off the single generic term that survived pruning.
    const out = await recentPoorRecallQueries(
      readDb([row({ termCount: 12, scoringTermCount: 1, resultCount: 8, topCoverage: 1 })]) as never,
      "company-1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.recognizedRatio).toBeCloseTo(1 / 12, 5);
  });

  it("drops a healthy search", async () => {
    const out = await recentPoorRecallQueries(readDb([row({})]) as never, "company-1");
    expect(out).toHaveLength(0);
  });

  it("returns healthy searches too when asked for all of them", async () => {
    const out = await recentPoorRecallQueries(readDb([row({})]) as never, "company-1", {
      includeAll: true,
    });
    expect(out).toHaveLength(1);
  });

  it("leaves the ratio null for rows written before the column existed", async () => {
    // Those rows must not be flagged on a ratio nobody recorded.
    const out = await recentPoorRecallQueries(
      readDb([row({ scoringTermCount: null })]) as never,
      "company-1",
    );
    expect(out).toHaveLength(0);
  });

  it("honours a caller-supplied threshold instead of a baked-in one", async () => {
    const rows = [row({ termCount: 10, scoringTermCount: 7 })];
    expect(await recentPoorRecallQueries(readDb(rows) as never, "company-1")).toHaveLength(0);
    expect(
      await recentPoorRecallQueries(readDb(rows) as never, "company-1", { ratioBelow: 0.8 }),
    ).toHaveLength(1);
  });
});

describe("the two writers stay on separate tables", () => {
  it("does not write the query log into the citation ledger", async () => {
    await recordRecallQuery(db as never, actor, "q", hit);
    await recordServed(db as never, actor, "q", [
      { kind: "wiki", id: "11111111-1111-1111-1111-111111111111" },
    ]);
    expect(db.inserts).toHaveLength(2);
    // Different grains: one row per search versus one row per asset. Mixing
    // them would oblige every existing consumer to filter.
    expect(db.inserts[0]!.table).not.toBe(db.inserts[1]!.table);
  });
});
