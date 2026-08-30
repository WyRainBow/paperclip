import { Command } from "commander";
import pc from "picocolors";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface DocumentLookupResponse {
  query: string;
  matches: Array<{
    documentId: string;
    companyId: string;
    key: string;
    title: string | null;
    latestRevisionNumber: number;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    updatedAt: string;
    issue: { id: string; identifier: string; title: string; status: string };
  }>;
}

export function registerDocumentCommands(program: Command): void {
  const document = program.command("document").description("Document operations");

  addCommonClientOptions(
    document
      .command("lookup")
      .description("Look up an issue document by docID (8-char prefix) or full uuid, with its owning issue")
      .argument("<idOrPrefix>", "Document id prefix (docID, e.g. d5e387b2) or full uuid")
      .action(async (idOrPrefix: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get<DocumentLookupResponse>(apiPath`/api/documents/${idOrPrefix}`);
          if (!result) {
            console.error("Empty response from document lookup");
            process.exitCode = 1;
            return;
          }
          if (ctx.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const noun = result.matches.length === 1 ? "match" : "matches";
          console.log(pc.bold(`${result.query} → ${result.matches.length} ${noun}`));
          for (const match of result.matches) {
            console.log(
              `  ${match.documentId}  ${match.key}  r${match.latestRevisionNumber}  ${match.title ?? "(untitled)"}`,
            );
            console.log(
              pc.dim(`    → ${match.issue.identifier} (${match.issue.status})  ${match.issue.title}`),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
