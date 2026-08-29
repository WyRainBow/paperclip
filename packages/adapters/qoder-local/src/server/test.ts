import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string | null {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function resolveQoderConfigDir(env: Record<string, string>): string {
  return (
    env.QODER_CONFIG_DIR?.trim() ||
    process.env.QODER_CONFIG_DIR?.trim() ||
    env.QODERCN_CONFIG_DIR?.trim() ||
    process.env.QODERCN_CONFIG_DIR?.trim() ||
    path.join(os.homedir(), ".qoder")
  );
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "qoder");
  const cwd = asString(config.cwd, "").trim() || process.cwd();
  const runId = `qoder-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "qoder_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "qoder_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "qoder_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "qoder_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the Qoder desktop app so the `qoder` CLI is on PATH.",
    });
  }

  const canProbe = checks.every((check) => check.code !== "qoder_cwd_invalid" && check.code !== "qoder_command_unresolvable");

  if (canProbe) {
    const versionProbe = await runChildProcess(runId, command, ["--version"], {
      cwd,
      env: { ...env, QODER_AGENT_SDK_ENTRYPOINT: "" },
      timeoutSec: 15,
      graceSec: 5,
      onLog: async () => {},
    });
    const versionLine = firstNonEmptyLine(versionProbe.stdout) || firstNonEmptyLine(versionProbe.stderr);
    if (!versionProbe.timedOut && (versionProbe.exitCode ?? 1) === 0) {
      checks.push({
        code: "qoder_version_detected",
        level: "info",
        message: `Qoder CLI detected${versionLine ? `: ${versionLine.replace(/\s+/g, " ").trim().slice(0, 120)}` : "."}`,
      });
    } else {
      checks.push({
        code: "qoder_version_probe_failed",
        level: "warn",
        message: versionProbe.timedOut ? "`qoder --version` timed out." : "`qoder --version` did not exit cleanly.",
        ...(versionLine ? { detail: versionLine } : {}),
      });
    }
  }

  const configDir = resolveQoderConfigDir(env);
  if (await pathExists(path.join(configDir, "settings.json"))) {
    checks.push({
      code: "qoder_auth_detected",
      level: "info",
      message: "Qoder desktop configuration detected.",
      detail: `Source: ${configDir}. The CLI inherits auth from the signed-in desktop app.`,
    });
  } else {
    checks.push({
      code: "qoder_auth_missing",
      level: "warn",
      message: "No Qoder desktop configuration detected.",
      hint: "Open the Qoder desktop app and sign in on this host, then retry the probe.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
