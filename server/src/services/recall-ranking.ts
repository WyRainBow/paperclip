/**
 * Pure ranking logic for the recall channel (MUL-441).
 *
 * Lifted out of `routes/workspace-recall.ts` so it can be tested without a
 * database, and so the three consumers (workspace recall, issue similarity,
 * future similar-card panels) score candidates the same way instead of each
 * growing its own copy.
 *
 * The route keeps ownership of fetching rows and spending the budget. This
 * module only answers "given these candidate texts and this query, what
 * order do they go in".
 */

/**
 * Query tokenization.
 *
 * The old rule was `query.split(/\s+/)`, which is correct for English and
 * useless for Chinese: a Chinese query carries no spaces, so the whole
 * sentence became one token and went into `ilike '%怎么归档拍板结论%'`, which
 * cannot match anything. Measured 2026-08-30: eight natural Chinese questions,
 * zero hits, all eight for this reason.
 *
 * Chinese is segmented into overlapping bigrams rather than words. Bigrams
 * need no dictionary and no new dependency, and they degrade gracefully: a
 * query about 「归档」 still overlaps a page about 「评审归档」 even though
 * neither side agrees on where the word boundary is. Latin runs keep whole-word
 * tokens, which is what they were already getting.
 */
const CJK_RUN = /[一-鿿㐀-䶿]+/g;
const LATIN_RUN = /[A-Za-z0-9][A-Za-z0-9_.-]*/g;

/**
 * Bigrams that carry no topic. A Chinese question is mostly scaffolding
 * (怎么/如果/应该/什么), and scaffolding matches every page in the corpus, so
 * leaving it in makes every candidate look equally relevant. This list stays
 * deliberately short: it holds interrogatives and pure function words, never
 * domain vocabulary.
 */
const STOP_BIGRAMS = new Set([
  "怎么", "么办", "如何", "什么", "为什", "么样", "哪里", "哪个", "哪些",
  "可以", "应该", "需要", "是否", "能不", "不能", "要不", "的时", "时候",
  "我们", "你们", "他们", "自己", "这个", "那个", "这样", "那样", "东西",
  "的东", "还能", "回来", "出来", "起来", "一下", "一个", "之后", "之前",
  "的话", "了吗", "吗", "呢", "的", "了", "是", "在", "和", "与", "或",
]);

export interface QueryTokens {
  /** Tokens used for matching, stop words removed. */
  terms: string[];
  /** Every token before stop-word removal, for callers that need the raw form. */
  rawTerms: string[];
}

export function tokenizeQuery(query: string): QueryTokens {
  const rawTerms: string[] = [];

  for (const run of query.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      rawTerms.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) rawTerms.push(run.slice(i, i + 2));
  }
  for (const run of query.match(LATIN_RUN) ?? []) {
    if (run.length >= 2) rawTerms.push(run.toLowerCase());
  }

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of rawTerms) {
    if (STOP_BIGRAMS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }

  // A query made entirely of stop words still deserves an answer. Falling back
  // to the raw tokens keeps "怎么办" from returning nothing at all.
  if (terms.length === 0) return { terms: [...new Set(rawTerms)], rawTerms };
  return { terms, rawTerms };
}

export interface ScorableCandidate {
  /**
   * Grouping key for dedupe. Two chunks of the same wiki page share it, so one
   * page cannot occupy every result slot — measured 2026-08-30, `agent-identity`
   * took all three top spots and pushed every other page out.
   */
  sourceKey: string;
  /** Weighted higher than body: a term in the title is a stronger signal. */
  title: string;
  body: string;
}

export interface CandidateScore {
  /** How many scoring terms appear anywhere in the candidate. */
  matched: number;
  /** Share of the query's total information weight this candidate matched, 0..1. */
  coverage: number;
  /** First matching offset in the body, or -1. Drives snippet placement. */
  bodyIndex: number;
  /** Keyword score before adoption boost and before semantic blending. */
  score: number;
}

const TITLE_WEIGHT = 2;

/**
 * Term weights for one query against one candidate set.
 *
 * Bigram tokenization produces two kinds of token. Real ones straddle no word
 * boundary (归档, 拍板, 结论) and appear in the corpus. Junk ones straddle a
 * boundary (么归, 档拍, 板结) and appear nowhere. Counting both in the
 * denominator is what sank the first cut: a query whose one meaningful term
 * matched the right page perfectly still scored 1/6 and fell under the floor.
 * Measured 2026-08-30, 「误删的东西还能救回来吗」 matched 误删 inside
 * `issue-restore-from-backup` and was discarded for exactly this reason.
 *
 * Terms nobody has (df = 0) separate no candidate from any other, so they are
 * dropped from scoring entirely. The rest are weighted by inverse document
 * frequency, which is what lets a rare topic word outrank a common one.
 */
export interface TermWeights {
  /** Terms that survived df = 0 pruning, in query order. */
  terms: string[];
  weight: Map<string, number>;
  totalWeight: number;
}

export function buildTermWeights(candidates: ScorableCandidate[], terms: string[]): TermWeights {
  const df = new Map<string, number>();
  for (const candidate of candidates) {
    const haystack = (candidate.title + "\n" + candidate.body).toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const n = Math.max(candidates.length, 1);
  const kept: string[] = [];
  const weight = new Map<string, number>();
  let totalWeight = 0;

  for (const term of terms) {
    const seen = df.get(term) ?? 0;
    if (seen === 0) continue;
    // Present everywhere means it separates nothing, present once means it is
    // the whole signal. log keeps that spread from becoming extreme.
    const idf = Math.log(1 + n / seen);
    kept.push(term);
    weight.set(term, idf);
    totalWeight += idf;
  }

  return { terms: kept, weight, totalWeight };
}

/**
 * Scores one candidate against the weighted query.
 *
 * The old rule required every term to appear (`and(...terms.map(...))`). With
 * bigrams that is unsatisfiable, and even with whole words it made a partial
 * overlap vanish rather than rank lower. Matching is now "any term counts,
 * weighted by how much that term narrows the field".
 */
export function scoreCandidate(
  candidate: ScorableCandidate,
  weights: TermWeights,
): CandidateScore {
  const lowerTitle = candidate.title.toLowerCase();
  const lowerBody = candidate.body.toLowerCase();

  let matched = 0;
  let hitWeight = 0;
  let titleWeight = 0;
  let bodyIndex = -1;

  for (const term of weights.terms) {
    const w = weights.weight.get(term) ?? 0;
    const inTitle = lowerTitle.includes(term);
    const at = lowerBody.indexOf(term);
    if (!inTitle && at < 0) continue;
    matched += 1;
    hitWeight += w;
    if (inTitle) titleWeight += w;
    if (at >= 0 && (bodyIndex < 0 || at < bodyIndex)) bodyIndex = at;
  }

  const total = weights.totalWeight;
  const coverage = total > 0 ? hitWeight / total : 0;
  const score = coverage + (total > 0 ? (titleWeight / total) * TITLE_WEIGHT : 0);

  return { matched, coverage, bodyIndex, score };
}

/**
 * Minimum weighted coverage a candidate needs to be worth returning.
 *
 * Set against the real wiki corpus: a candidate sharing only a low-information
 * term with the query lands under it, one sharing the query's actual topic word
 * lands over it.
 */
export const MIN_COVERAGE = 0.15;

export interface RankableHit extends CandidateScore {
  sourceKey: string;
}

/**
 * Sorts by score and keeps at most `perSourceLimit` hits per sourceKey.
 *
 * Dedupe happens after sorting so the best chunk of a page is the one that
 * survives.
 */
export function rankAndDedupe<T extends RankableHit>(
  hits: T[],
  options: { limit: number; perSourceLimit?: number },
): T[] {
  const perSource = options.perSourceLimit ?? 1;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const takenPerSource = new Map<string, number>();
  const out: T[] = [];

  for (const hit of sorted) {
    if (out.length >= options.limit) break;
    const taken = takenPerSource.get(hit.sourceKey) ?? 0;
    if (taken >= perSource) continue;
    takenPerSource.set(hit.sourceKey, taken + 1);
    out.push(hit);
  }
  return out;
}

/** Extracts a snippet around the first match, matching the route's old shape. */
export function buildSnippet(body: string, bodyIndex: number, width = 400, lead = 100): string {
  if (bodyIndex < 0) return body.slice(0, 300) + (body.length > 300 ? "…" : "");
  const start = Math.max(0, bodyIndex - lead);
  const slice = body.slice(start, start + Math.min(width, body.length - start));
  return (start > 0 ? "…" : "") + slice;
}
