import { describe, expect, it } from "vitest";
import { buildQoderLocalConfig } from "./build-config.js";

describe("buildQoderLocalConfig", () => {
  it("builds a minimal config from form values", () => {
    const ac = buildQoderLocalConfig({
      cwd: "/repo",
      model: "Qwen3.8-Max",
      command: "qoder",
      extraArgs: "--foo, --bar",
      envVars: "A=1\n# comment\nB=2",
    } as never);
    expect(ac).toMatchObject({
      cwd: "/repo",
      model: "Qwen3.8-Max",
      command: "qoder",
      extraArgs: ["--foo", "--bar"],
      timeoutSec: 0,
      graceSec: 15,
    });
    expect(ac.env).toEqual({
      A: { type: "plain", value: "1" },
      B: { type: "plain", value: "2" },
    });
  });

  it("omits model and command when unset so CLI defaults apply", () => {
    const ac = buildQoderLocalConfig({} as never);
    expect(ac).not.toHaveProperty("model");
    expect(ac).not.toHaveProperty("command");
    expect(ac).not.toHaveProperty("env");
  });
});
