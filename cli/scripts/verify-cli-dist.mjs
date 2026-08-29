// MUL-139 build gate: the bundle must serve every subcommand the source
// registers under `workspace`. Added after cite/stats/remember landed in
// master while the deployed dist kept answering "unknown command" — a gap
// typecheck cannot see because dist is gitignored. Runs as part of
// `pnpm --filter paperclipai build`; a missing command fails the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(cliRoot, "src", "commands", "client", "workspace-recall.ts");
const distPath = path.join(cliRoot, "dist", "index.js");

const source = fs.readFileSync(sourcePath, "utf8");
const dist = fs.readFileSync(distPath, "utf8");

const names = [...new Set([...source.matchAll(/\.command\("([a-z0-9:-]+)"\)/g)].map((m) => m[1]))].sort();
const missing = names.filter((name) => !dist.includes(`.command("${name}")`));

if (missing.length > 0) {
  console.error(`verify-cli-dist: bundle is missing workspace subcommands: ${missing.join(", ")}`);
  console.error("verify-cli-dist: the bundle in dist/ does not match cli/src — rebuild did not pick up the source?");
  process.exit(1);
}
console.log(`verify-cli-dist: all ${names.length} workspace subcommands present in dist (${names.join(", ")})`);
