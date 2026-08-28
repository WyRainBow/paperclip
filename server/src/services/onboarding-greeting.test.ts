import { describe, expect, it } from "vitest";
import { buildOnboardingGreeting } from "./onboarding-greeting.js";

describe("buildOnboardingGreeting", () => {
  it("introduces the agent by name as the user's first teammate and reflects the goals", () => {
    const greeting = buildOnboardingGreeting({
      agentName: "Nova",
      teamName: "Acme",
      goals: "Launch a marketplace for local makers.",
    });

    expect(greeting).toContain(
      "Welcome! I'm Nova, your first agent teammate on Paperclip.",
    );
    expect(greeting).toContain("Here's what I understand you're aiming for:");
    expect(greeting).toContain("> Launch a marketplace for local makers.");
    expect(greeting).toContain("propose a team of agents");
    expect(greeting).toContain("few focused questions");
  });

  it("falls back to a generic teammate intro when no agent name is set", () => {
    const greeting = buildOnboardingGreeting({ agentName: null, goals: null });

    expect(greeting).toContain(
      "Welcome! I'm your first agent teammate on Paperclip.",
    );
  });

  it("collapses whitespace in the reflected goals", () => {
    const greeting = buildOnboardingGreeting({
      goals: "  Build\n\n  a  SaaS product.  ",
    });

    expect(greeting).toContain("> Build a SaaS product.");
  });

  it("omits the reflect-back block when no goals are provided", () => {
    const greeting = buildOnboardingGreeting({ agentName: "Nova", goals: null });

    expect(greeting).not.toContain("aiming for");
    expect(greeting).toContain("propose a team of agents");
  });
});

describe("buildOnboardingGreeting (zh-CN)", () => {
  it("writes the greeting in Simplified Chinese when the language is zh-CN", () => {
    const greeting = buildOnboardingGreeting({
      agentName: "Nova",
      teamName: "Acme",
      goals: "做一个本地手艺人的市集。",
      language: "zh-CN",
    });

    expect(greeting).toContain("欢迎！我是 Nova，你在 Paperclip 上的第一位 Agent 队友。");
    expect(greeting).toContain("我理解你想达成的是：");
    expect(greeting).toContain("> 做一个本地手艺人的市集。");
    expect(greeting).toContain("稍等片刻");
  });

  it("keeps English wording for unknown or absent languages", () => {
    expect(buildOnboardingGreeting({ agentName: "Nova", language: "fr" })).toContain("Welcome!");
    expect(buildOnboardingGreeting({ agentName: "Nova", language: null })).toContain("Welcome!");
  });
});
