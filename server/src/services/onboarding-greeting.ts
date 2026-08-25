// Deterministic, template-driven greeting seeded as an agent-authored comment on
// the onboarding first task. No LLM call: it reflects back the onboarding context
// (team name + goals) so the user lands on a waiting greeting instead of a
// right-aligned "user" bubble showing the agent's own seeded instructions.

export const ONBOARDING_GREETING_AUTHORIZATION_REASON = "onboarding first-task greeting";

export function buildOnboardingGreeting(input: {
  agentName?: string | null;
  teamName?: string | null;
  goals?: string | null;
  language?: string | null;
}): string {
  const agentName = input.agentName?.trim();
  const goals = input.goals?.replace(/\s+/g, " ").trim();
  const zh = input.language === "zh-CN";

  // Introduce the agent by the name the user chose in onboarding when we have
  // it, so the first message reads as coming from *their* first teammate rather
  // than a generic agent. Fall back to the generic phrasing otherwise.
  const identity = zh
    ? (agentName
      ? `欢迎！我是 ${agentName}，你在 Paperclip 上的第一位 Agent 队友。`
      : "欢迎！我是你在 Paperclip 上的第一位 Agent 队友。")
    : (agentName
      ? `Welcome! I'm ${agentName}, your first agent teammate on Paperclip.`
      : "Welcome! I'm your first agent teammate on Paperclip.");

  const lines: string[] = [];
  lines.push(identity);

  if (goals) {
    lines.push("");
    lines.push(zh ? "我理解你想达成的是：" : "Here's what I understand you're aiming for:");
    lines.push("");
    lines.push(`> ${goals}`);
  }

  lines.push("");
  lines.push(
    zh
      ? "我想先补充一些背景信息，然后给出方案并提议一支 Agent 团队来执行。我正在整理几个聚焦的问题，以便我们先确定一个具体的首要目标。请稍等片刻……"
      : "I want to gather more context so I can come up with a plan and propose a team of agents to help execute it. I'm putting together a few focused questions so we can settle on a concrete goal to tackle first. Please give me one moment...",
  );

  return lines.join("\n");
}
