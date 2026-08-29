import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

// Real-CLI probe: runs only when the qoder CLI is present and signed in on
// this host. CI environments without Qoder skip it.
const qoderAvailable = spawnSync("qoder", ["--version"], {
  env: { ...process.env, QODER_AGENT_SDK_ENTRYPOINT: "" },
  timeout: 15_000,
}).status === 0;

describe.skipIf(!qoderAvailable)("qoder execute (real CLI)", () => {
  it("runs a headless prompt and returns a parsed result", { timeout: 120_000 }, async (testContext) => {
    const ctx: AdapterExecutionContext = {
      runId: "qoder-adapter-probe",
      agent: { id: "probe-agent", companyId: "probe-company", name: "Probe", adapterType: "qoder_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: "/tmp", promptTemplate: "Reply with exactly one word: pong", timeoutSec: 90 },
      context: {},
      onLog: async () => {},
    };

    const result = await execute(ctx);
    if (result.errorMessage?.includes("credit usage limit")) {
      // Provider quota exhausted on this host — an account state, not an
      // adapter defect. The lane itself is verified by the parsed error path.
      expect(result.errorMessage).toBeTruthy();
      testContext.skip();
      return;
    }
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toContain("pong");
    expect(result.sessionId).toBeTruthy();
    expect(result.model).toBeTruthy();
  });
});
