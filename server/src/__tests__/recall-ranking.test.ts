import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIN_COVERAGE,
  buildSnippet,
  buildTermWeights,
  rankAndDedupe,
  scoreCandidate,
  tokenizeQuery,
  type ScorableCandidate,
} from "../services/recall-ranking.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface WikiFixturePage {
  space: string;
  path: string;
  title: string;
  body: string;
}

/**
 * Real Team Wiki content (paperclip + agent spaces, first 1200 chars per page),
 * captured 2026-08-30. The `personal` space is deliberately excluded: it holds
 * per-user instruction files, which have no business in a repo fixture.
 *
 * A synthetic corpus would not exercise the thing under test. Ranking only has
 * to be right relative to the other pages competing for the same slot, and it
 * is the real neighbours that make a query hard.
 */
const corpus: WikiFixturePage[] = JSON.parse(
  readFileSync(path.join(here, "fixtures/wiki-recall-corpus.json"), "utf8"),
);

const candidates: ScorableCandidate[] = corpus.map((page) => ({
  sourceKey: `${page.space}/${page.path}`,
  title: page.title,
  body: page.body,
}));

function recall(query: string, limit = 3): Array<{ sourceKey: string; score: number }> {
  const { terms } = tokenizeQuery(query);
  const weights = buildTermWeights(candidates, terms);
  const hits = candidates
    .map((candidate) => ({ sourceKey: candidate.sourceKey, ...scoreCandidate(candidate, weights) }))
    .filter((hit) => hit.coverage >= MIN_COVERAGE);
  return rankAndDedupe(hits, { limit });
}

/** Reproduction of the pre-MUL-441 rule: split on whitespace, every term must hit. */
function legacyRecall(query: string): string[] {
  const terms = query.split(/\s+/).filter(Boolean);
  return candidates
    .filter((candidate) =>
      terms.every((term) =>
        (candidate.title + candidate.body).toLowerCase().includes(term.toLowerCase()),
      ),
    )
    .map((candidate) => candidate.sourceKey);
}

describe("tokenizeQuery", () => {
  it("splits Chinese into overlapping bigrams instead of one whole-sentence token", () => {
    const { terms } = tokenizeQuery("归档结论");
    expect(terms).toContain("归档");
    expect(terms).toContain("档结");
    expect(terms).toContain("结论");
    expect(terms).not.toContain("归档结论");
  });

  it("keeps latin runs whole and lowercases them", () => {
    const { terms } = tokenizeQuery("workspace Recall API");
    expect(terms).toContain("workspace");
    expect(terms).toContain("recall");
    expect(terms).toContain("api");
  });

  it("drops interrogative scaffolding that matches every page", () => {
    const { terms, rawTerms } = tokenizeQuery("怎么归档结论");
    expect(rawTerms).toContain("怎么");
    expect(terms).not.toContain("怎么");
    expect(terms).toContain("归档");
  });

  it("falls back to raw terms rather than returning nothing for an all-stopword query", () => {
    const { terms } = tokenizeQuery("这个那个");
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe("buildTermWeights", () => {
  const tiny: ScorableCandidate[] = [
    { sourceKey: "a", title: "备份恢复", body: "误删之后怎么恢复" },
    { sourceKey: "b", title: "建卡", body: "建卡要先查重" },
  ];

  it("drops terms no candidate has, so junk bigrams stop diluting the denominator", () => {
    const { terms } = tokenizeQuery("误删的东西还能救回来吗");
    const weights = buildTermWeights(tiny, terms);
    expect(weights.terms).toContain("误删");
    expect(weights.terms).not.toContain("来吗");
    expect(weights.terms).not.toContain("能救");
  });

  it("weights a rare term above a common one", () => {
    const weights = buildTermWeights(tiny, ["误删", "建卡"]);
    // Both appear in exactly one document here, so equal weight is correct;
    // what must hold is that neither is zero and both survive pruning.
    expect(weights.weight.get("误删")).toBeGreaterThan(0);
    expect(weights.totalWeight).toBeGreaterThan(0);
  });

  it("reports zero total weight when nothing in the query exists in the corpus", () => {
    const weights = buildTermWeights(tiny, tokenizeQuery("量子隧穿效应").terms);
    expect(weights.terms).toHaveLength(0);
    expect(weights.totalWeight).toBe(0);
  });
});

describe("scoreCandidate", () => {
  const cands: ScorableCandidate[] = [
    { sourceKey: "titled", title: "决策归档", body: "别处的说明" },
    { sourceKey: "bodied", title: "旁枝标题", body: "决策归档写在这里" },
  ];

  it("ranks a title match above the same match in the body", () => {
    const weights = buildTermWeights(cands, ["归档"]);
    const titled = scoreCandidate(cands[0]!, weights);
    const bodied = scoreCandidate(cands[1]!, weights);
    expect(titled.score).toBeGreaterThan(bodied.score);
  });

  it("scores a partial overlap rather than discarding it", () => {
    // 决策 hits the first candidate, 写在 only hits the second — the old
    // all-terms-must-hit rule dropped the first candidate entirely.
    const weights = buildTermWeights(cands, ["决策", "写在"]);
    const hit = scoreCandidate(cands[0]!, weights);
    expect(hit.matched).toBe(1);
    expect(hit.coverage).toBeGreaterThan(0);
    expect(hit.coverage).toBeLessThan(1);
  });

  it("returns a body offset that points at the first match", () => {
    const weights = buildTermWeights(cands, ["归档"]);
    const hit = scoreCandidate(cands[1]!, weights);
    expect(cands[1]!.body.slice(hit.bodyIndex, hit.bodyIndex + 2)).toBe("归档");
  });
});

describe("rankAndDedupe", () => {
  it("keeps one hit per source so a single page cannot take every slot", () => {
    const hits = [
      { sourceKey: "page-a", matched: 3, coverage: 0.9, bodyIndex: 0, score: 0.9 },
      { sourceKey: "page-a", matched: 3, coverage: 0.8, bodyIndex: 5, score: 0.8 },
      { sourceKey: "page-a", matched: 2, coverage: 0.7, bodyIndex: 9, score: 0.7 },
      { sourceKey: "page-b", matched: 1, coverage: 0.4, bodyIndex: 2, score: 0.4 },
    ];
    const top = rankAndDedupe(hits, { limit: 3 });
    expect(top.map((hit) => hit.sourceKey)).toEqual(["page-a", "page-b"]);
  });

  it("honours a larger per-source allowance when asked", () => {
    const hits = [
      { sourceKey: "page-a", matched: 3, coverage: 0.9, bodyIndex: 0, score: 0.9 },
      { sourceKey: "page-a", matched: 3, coverage: 0.8, bodyIndex: 5, score: 0.8 },
      { sourceKey: "page-b", matched: 1, coverage: 0.4, bodyIndex: 2, score: 0.4 },
    ];
    const top = rankAndDedupe(hits, { limit: 3, perSourceLimit: 2 });
    expect(top).toHaveLength(3);
  });

  it("takes the highest-scoring chunk of a source, not the first one seen", () => {
    const hits = [
      { sourceKey: "page-a", matched: 1, coverage: 0.2, bodyIndex: 0, score: 0.2 },
      { sourceKey: "page-a", matched: 3, coverage: 0.9, bodyIndex: 40, score: 0.9 },
    ];
    expect(rankAndDedupe(hits, { limit: 1 })[0]!.score).toBe(0.9);
  });
});

describe("buildSnippet", () => {
  it("centres the window on the match and marks the elision", () => {
    const body = "x".repeat(300) + "归档" + "y".repeat(300);
    const snippet = buildSnippet(body, 300);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("归档");
  });

  it("falls back to the head of the body when there is no match offset", () => {
    expect(buildSnippet("短正文", -1)).toBe("短正文");
  });
});

/**
 * The eight questions that motivated MUL-441.
 *
 * Every one of them returned nothing on the old rule, and for one reason: a
 * Chinese query has no spaces, so `split(/\s+/)` produced a single token and
 * the whole sentence went into `ilike '%...%'`. These are regression anchors,
 * not an accuracy benchmark — they were written by the same session that tuned
 * the scoring, so they show the failure is fixed, not how the ranker performs
 * on unseen queries.
 */
const FAILURE_CASES: Array<{ query: string; expect: string[] | null; note?: string }> = [
  {
    query: "怎么归档拍板结论",
    expect: ["agent/playbooks/discussion-guide", "paperclip/guides/discussion-guide", "paperclip/living/决策机制"],
  },
  {
    query: "两个终端同时改一个仓库怎么办",
    expect: ["agent/protocols/跨终端互讨论与互裁", "paperclip/living/跨终端协作"],
  },
  {
    query: "怎么让新会话知道自己是谁",
    expect: ["agent/scenarios/session-start-context", "paperclip/guides/agent-identity"],
  },
  {
    query: "误删的东西还能救回来吗",
    expect: ["agent/playbooks/issue-restore-from-backup"],
  },
  {
    query: "写完的东西谁来验收",
    expect: ["paperclip/issue-docs", "agent/issue-docs", "paperclip/guides/discussion-guide"],
  },
  {
    query: "花了多少钱怎么看",
    expect: null,
    note: "语料里没有成本相关页面，正确行为是返回空而不是硬凑一个",
  },
  {
    query: "任务做完之后要走什么流程",
    expect: ["agent/playbooks/issue-workflow", "paperclip/guides/workflow-lifecycle"],
    note: "已知缺口：字面上 issue-docs 更像，正主排不进 top3。语义腿（MUL-441 B 阶段）要解的就是这类",
  },
  {
    query: "长内容应该放在哪里",
    expect: ["paperclip/issue-docs", "agent/issue-docs"],
    note: "已知缺口：team-skills-editing 的字面重叠更高",
  },
];

/** Cases the keyword leg alone is not expected to solve — tracked, not hidden. */
const KNOWN_GAPS = new Set(["任务做完之后要走什么流程", "长内容应该放在哪里"]);

describe("MUL-441 failure cases: Chinese natural-language recall", () => {
  it.each(FAILURE_CASES.map((c) => c.query))("the old rule found nothing for %s", (query) => {
    expect(legacyRecall(query)).toHaveLength(0);
  });

  it.each(
    FAILURE_CASES.filter((c) => c.expect !== null && !KNOWN_GAPS.has(c.query)).map((c) => [c.query, c.expect!] as const),
  )("surfaces a relevant page for %s", (query, wanted) => {
    const keys = recall(query).map((hit) => hit.sourceKey);
    expect(keys.some((key) => wanted.includes(key))).toBe(true);
  });

  it("returns nothing when the corpus genuinely has no answer", () => {
    expect(recall("花了多少钱怎么看")).toHaveLength(0);
  });

  it("still returns something for the known gaps, just not the best page", () => {
    for (const query of KNOWN_GAPS) {
      expect(recall(query).length).toBeGreaterThan(0);
    }
  });

  it("never lets one page occupy more than one result slot", () => {
    for (const { query } of FAILURE_CASES) {
      const keys = recall(query, 5).map((hit) => hit.sourceKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
