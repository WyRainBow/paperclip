import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  detectTerminalSessionId,
  handleCommandError,
  printOutput,
  resolveCommandContext,
} from "./common.js";

interface RecallResult {
  query: string;
  budgetChars: number;
  usedChars: number;
  resultCount: number;
  totalHits: number;
  results: Array<{
    source: string;
    space: string | null;
    path: string | null;
    title: string;
    snippet: string;
    degraded: boolean;
    /** Null for cards and documents: they are not Team assets and cannot be cited. */
    assetKind: string | null;
    assetId: string;
    adoptionBoost: number;
    /** Cosine similarity from the semantic leg, 0 when it contributed nothing. */
    similarity: number;
  }>;
  references: string;
}

interface ReindexResult {
  model: string;
  provider: string;
  scannedChunks: number;
  embeddedChunks: number;
  deletedRows: number;
  tokens: number;
  stoppedBecause?: string;
}

interface AssetHealthRow {
  assetKind: string;
  assetId: string;
  title: string;
  path: string | null;
  servedCount: number;
  citedCount: number;
  lastServedAt: string | null;
  lastCitedAt: string | null;
  deadWeight: boolean;
  downVotes: number;
  downVoteIssueIds: string[];
  disputed: boolean;
  latestVersionId: string | null;
  latestRevisionNumber: number | null;
  lastRevisedAt: string | null;
}

export function registerWorkspaceRecallCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === "workspace");
  if (!existing) return;

  addCommonClientOptions(
    existing
      .command("recall")
      .description("Search Team Wiki, Team Rules, cards, their documents and decisions within a token budget; natural-language questions work, not only keywords")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .requiredOption("--query <query>", "What to search for")
      .option("--budget <chars>", "Character budget for results (default 2000, max 6000)")
      .option("--issue <id>", "Issue this recall serves — recorded on the ledger so adoption can be checked against the card later")
      .option("--session <id>", "Session id to record on the ledger when there is no issue")
      .action(async (opts: { companyId?: string; query: string; budget?: string; issue?: string; session?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams({ q: opts.query });
          if (opts.budget) params.set("budget", opts.budget);
          if (opts.issue) params.set("issue", opts.issue);
          // Falls back to the host terminal's session id (MUL-449). The
          // parameter existed before but had to be passed by hand, so all 340
          // served ledger rows had a null session_id and "did this session
          // have to search twice" could not be answered.
          const sessionId = opts.session?.trim() || detectTerminalSessionId();
          if (sessionId) params.set("session", sessionId);
          const base = apiPath`/api/companies/${ctx.companyId}/workspace/recall`;
          const resp = await ctx.api.get<RecallResult>(`${base}?${params}`);
          if (!resp) throw new Error("recall returned no data");
          if (opts.json) {
            printOutput(resp, { json: true });
            return;
          }
          console.error(`查询「${resp.query}」：${resp.resultCount}/${resp.totalHits} 条命中（预算 ${resp.usedChars}/${resp.budgetChars} 字符）\n`);
          for (const hit of resp.results) {
            const loc = hit.space ? `[${hit.source}/${hit.space}]` : `[${hit.source}]`;
            const adopted = hit.adoptionBoost > 0 ? ` ·已被采纳过(+${hit.adoptionBoost})` : "";
            // Says which leg found this. A hit the keyword leg could never have
            // reached is worth flagging: it tells the reader the wording of
            // their question is not what matched, so a follow-up query should
            // not lean on those exact words.
            const semantic = hit.similarity > 0 ? ` ·语义命中(${hit.similarity.toFixed(2)})` : "";
            if (hit.degraded) {
              console.log(`${loc} ${hit.title}${adopted}${semantic} — 预算不足，仅标题`);
            } else {
              console.log(`${loc} ${hit.title} (${hit.path})${adopted}${semantic}`);
              console.log(`  ${hit.snippet.replace(/\n/g, "\n  ")}`);
            }
            console.log();
          }
          console.log(`引用声明：\n${resp.references}`);
          // Only Team assets get a citable ref, so the reminder is skipped when
          // nothing in this batch can be cited.
          if (resp.results.some((hit) => hit.assetKind)) {
            console.log(`\n用上哪几条，收尾时声明一次：paperclipai workspace cite --asset <上面的 kind:id> [--issue <卡 id>]`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("recall:reindex")
      .description("Rebuild the semantic recall vector index — incremental, only re-embeds chunks whose text changed")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .option("--max-chunks <n>", "Cap how many chunks this pass may embed (default 2000)")
      .action(async (opts: { companyId?: string; maxChunks?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.maxChunks) params.set("maxChunks", opts.maxChunks);
          const base = apiPath`/api/companies/${ctx.companyId}/workspace/recall/reindex`;
          const resp = await ctx.api.post<ReindexResult>(
            params.toString() ? `${base}?${params}` : base,
            {},
          );
          if (!resp) throw new Error("reindex returned no data");
          if (opts.json) {
            printOutput(resp, { json: true });
            return;
          }
          console.error(`索引刷新（${resp.provider} / ${resp.model}）`);
          console.log(
            `扫描 ${resp.scannedChunks} 块，重嵌 ${resp.embeddedChunks} 块，清理 ${resp.deletedRows} 条，消耗 ${resp.tokens} token`,
          );
          if (resp.stoppedBecause) {
            // Never silent: a capped or aborted pass leaves the index partly
            // stale, and a caller who does not know that will read the next
            // recall as if it were complete.
            console.log(`本轮提前停止：${resp.stoppedBecause}。再跑一次继续。`);
          } else if (resp.embeddedChunks === 0) {
            console.log("语料没有变化，本轮没有花费。");
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("cite")
      .description("Declare which recalled assets this session actually used — the adoption half of the ledger")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .requiredOption("--asset <kind:id...>", "Asset refs copied from a recall response, e.g. rule:<uuid> wiki:<uuid>")
      .option("--issue <id>", "Issue this work belongs to — the key that lets a human check the claim against the card")
      .option("--session <id>", "Session id, when there is no issue to attach to")
      .action(async (opts: { companyId?: string; asset: string[]; issue?: string; session?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const resp = await ctx.api.post<{ declared: number; recorded: number; duplicates: number }>(
            apiPath`/api/companies/${ctx.companyId}/workspace/citations`,
            { issueId: opts.issue, sessionId: opts.session, assets: opts.asset },
          );
          if (opts.json) {
            printOutput(resp, { json: true });
            return;
          }
          console.log(`声明 ${resp?.declared ?? 0} 条，新记 ${resp?.recorded ?? 0} 条，重复 ${resp?.duplicates ?? 0} 条`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("assets-health")
      .description("Served/cited counts per team asset — names dead-weight candidates, prunes nothing")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .option("--dead-only", "Only show assets served enough to have had their chance and never cited")
      .action(async (opts: { companyId?: string; deadOnly?: boolean; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const resp = await ctx.api.get<{ assets: AssetHealthRow[]; deadWeightCount: number }>(
            apiPath`/api/companies/${ctx.companyId}/workspace/assets/health`,
          );
          const assets = (resp?.assets ?? []).filter((row) => (opts.deadOnly ? row.deadWeight : true));
          if (opts.json) {
            printOutput({ ...resp, assets }, { json: true });
            return;
          }
          console.error(`资产 ${assets.length} 条，死重候选 ${resp?.deadWeightCount ?? 0} 条\n`);
          for (const row of assets) {
            const flags = [
              row.deadWeight ? "⚠死重" : null,
              row.disputed ? "⚠有争议" : null,
            ].filter(Boolean).join(" ");
            console.log(`[${row.assetKind}] ${row.title}${row.path ? ` (${row.path})` : ""}${flags ? ` ${flags}` : ""}`);
            const versionRef = row.latestVersionId
              ? ` · 版本 r${row.latestRevisionNumber}=${row.latestVersionId.slice(0, 8)}（缺陷票投这个 id）`
              : "";
            console.log(`  发出 ${row.servedCount} 次 / 采纳 ${row.citedCount} 次 / down 票 ${row.downVotes} 次（${row.downVoteIssueIds.length} 张卡） · ${row.assetKind}:${row.assetId}${versionRef}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("remember")
      .description("File a reusable experience into Team Wiki agent/cases — Situation/Approach/Reflect, versioned by title, recallable at once")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .requiredOption("--title <title>", "Name the generalizable pattern, not the incident (same title = new revision of the same page)")
      .requiredOption("--situation <text>", "Entry conditions: when this entire pattern applies")
      .requiredOption("--approach <text>", "Imperative DOs: the optimized execution path, direct tool actions only")
      .requiredOption("--reflect <text>", "Hard DON'Ts: negative rules, boundaries, failure-prevention heuristics")
      .option("--issue <id>", "Card this experience came from — lets a human verify against the card")
      .option("--supersedes <path>", "agent-space path of the experience this one replaces (old page is kept, not deleted)")
      .action(async (opts: { companyId?: string; title: string; situation: string; approach: string; reflect: string; issue?: string; supersedes?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const resp = await ctx.api.post<{
            pageId: string;
            path: string;
            space: string;
            title: string;
            revisionNumber: number;
            created: boolean;
            assetRef: string;
            note: string;
          }>(
            apiPath`/api/companies/${ctx.companyId}/workspace/remember`,
            {
              title: opts.title,
              situation: opts.situation,
              approach: opts.approach,
              reflect: opts.reflect,
              issueId: opts.issue,
              supersedesPath: opts.supersedes,
            },
          );
          if (opts.json) {
            printOutput(resp, { json: true });
            return;
          }
          if (!resp) throw new Error("remember returned no data");
          console.log(`${resp.created ? "新经验页" : "同名经验已更新"}：${resp.space}/${resp.path}（r${resp.revisionNumber}）`);
          console.log(`引用 ref：${resp.assetRef} · ${resp.note}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    existing
      .command("rules")
      .description("Read Team Rules full text — no search, no budget, the complete rules")
      .option("-C, --company-id <id>", "Company ID (falls back to PAPERCLIP_COMPANY_ID env or context profile)")
      .action(async (opts: { companyId?: string; json?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Array<{
            id: string; title: string; body: string; updatedAt: string;
          }>>(
            apiPath`/api/companies/${ctx.companyId}/workspace/rules`,
          )) ?? [];
          if (opts.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const note of rows) {
            console.log(`=== ${note.title} ===\n`);
            console.log(note.body);
            console.log(`\n--- 更新于 ${note.updatedAt} ---\n`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
