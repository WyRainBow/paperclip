import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// MUL-139: the knowledge-command family (recall/cite/stats/remember/rules) once
// landed in master source while the built cli/dist everyone actually runs kept
// serving an older bundle — recall's own output told agents to run
// `workspace cite`, and every terminal answered "unknown command". The gap is
// invisible to typecheck and tests because dist is gitignored; this test is the
// tripwire. It fails wherever a dist EXISTS but predates the source commands —
// on the main checkout that is exactly the broken state. In a fresh worktree
// with no dist it skips loudly (a skip is a skip, not a pass).

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourcePath = path.join(cliRoot, "src", "commands", "client", "workspace-recall.ts");
const defaultDist = path.join(cliRoot, "dist", "index.js");
const distPath = process.env.PAPERCLIP_DIST_FRESHNESS_TARGET
  ? path.resolve(process.env.PAPERCLIP_DIST_FRESHNESS_TARGET)
  : defaultDist;

/** Every subcommand the source registers under `workspace`. */
function registeredCommandNames(source: string): string[] {
  const names: string[] = [];
  const re = /\.command\("([a-z0-9:-]+)"\)/g;
  for (const m of source.matchAll(re)) names.push(m[1]);
  return [...new Set(names)].sort();
}

describe("cli dist freshness (MUL-139)", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  const names = registeredCommandNames(source);

  it("found the command registrations this test guards", () => {
    // If this ever fails the parser drifted, not the build — fix the regex.
    expect(names).toContain("recall");
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it.runIf(fs.existsSync(distPath))(
    `dist ${path.basename(path.dirname(distPath))}/index.js serves every workspace knowledge command`,
    () => {
      const dist = fs.readFileSync(distPath, "utf8");
      const missing = names.filter((name) => !dist.includes(`.command("${name}")`));
      expect(
        missing,
        `dist predates the source (missing: ${missing.join(", ")}). Rebuild with: pnpm --filter cli build — every terminal runs this bundle via the PATH symlink, source-only merges strand them on old commands.`,
      ).toEqual([]);
    },
  );

  it.skipIf(fs.existsSync(distPath))("dist not built in this checkout — skipped, not passed", () => {
    // Reached only when no dist exists. The skip is the message: freshness is
    // unverifiable until something builds. The main checkout and CI images
    // carry a dist, so the guard bites exactly where consumers live.
  });
});
