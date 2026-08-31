import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordMiss, recordServed } from "../services/asset-citations.js";

/**
 * `recordMiss` and `recordServed` both write through drizzle's insert builder,
 * so a fake that records what it was handed is enough to pin the contract:
 * which table, which columns, and — the part that matters — that a failure
 * never escapes. These two run on the path of every session start.
 */
function fakeDb() {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  let failNext = false;
  return {
    inserts,
    failWith(reason: string) {
      failNext = true;
      this.reason = reason;
    },
    reason: "",
    insert(table: unknown) {
      return {
        values: async (values: unknown) => {
          if (failNext) {
            failNext = false;
            throw new Error(this.reason || "insert failed");
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

const diagnostics = { termCount: 4, candidateCount: 0, semanticUsed: true };

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
});

describe("recordMiss", () => {
  it("writes one row carrying the query and all three diagnostics", async () => {
    const ok = await recordMiss(db as never, actor, "误删的卡怎么恢复", diagnostics);
    expect(ok).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.values).toMatchObject({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sessionId: "session-1",
      query: "误删的卡怎么恢复",
      termCount: 4,
      candidateCount: 0,
      semanticUsed: true,
    });
  });

  it("keeps the attribution columns null rather than inventing values", async () => {
    await recordMiss(db as never, { companyId: "company-1" }, "q", diagnostics);
    expect(db.inserts[0]!.values).toMatchObject({
      issueId: null,
      agentId: null,
      sessionId: null,
    });
  });

  it("never throws when the insert fails", async () => {
    // A ledger write must not take down the recall that caused it: the caller
    // is on the path of every session start.
    db.failWith("connection reset");
    await expect(recordMiss(db as never, actor, "q", diagnostics)).resolves.toBe(false);
    expect(db.inserts).toHaveLength(0);
  });

  it("skips an empty query instead of storing a blank row", async () => {
    expect(await recordMiss(db as never, actor, "   ", diagnostics)).toBe(false);
    expect(db.inserts).toHaveLength(0);
  });

  it("records termCount 0 as a real value, not as missing data", async () => {
    // Zero is the most informative reading there is: the tokenizer ate the
    // query. It must survive rather than be treated as absent.
    await recordMiss(db as never, actor, "?!", {
      termCount: 0,
      candidateCount: 0,
      semanticUsed: false,
    });
    expect(db.inserts[0]!.values).toMatchObject({ termCount: 0, semanticUsed: false });
  });
});

describe("recordServed still behaves as before", () => {
  it("writes nothing when there are no hits", async () => {
    // Unchanged on purpose. The citation ledger pairs served with cited so the
    // two can be divided; a miss is neither, and MUL-449 gave it its own table
    // rather than a third phase here.
    const written = await recordServed(db as never, actor, "q", []);
    expect(written).toBe(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("writes one row per hit", async () => {
    const written = await recordServed(db as never, actor, "q", [
      { kind: "wiki", id: "11111111-1111-1111-1111-111111111111", score: 2 },
      { kind: "rule", id: "22222222-2222-2222-2222-222222222222", score: 1 },
    ]);
    expect(written).toBe(2);
    expect((db.inserts[0]!.values as unknown[])).toHaveLength(2);
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

describe("the two writers stay on separate tables", () => {
  it("does not write a miss into the citation ledger", async () => {
    await recordMiss(db as never, actor, "q", diagnostics);
    await recordServed(db as never, actor, "q", [
      { kind: "wiki", id: "11111111-1111-1111-1111-111111111111" },
    ]);
    expect(db.inserts).toHaveLength(2);
    // Different table objects: putting a miss in the citation ledger would
    // oblige every existing consumer to filter it out forever.
    expect(db.inserts[0]!.table).not.toBe(db.inserts[1]!.table);
  });
});
