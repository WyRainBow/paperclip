import type { DecisionInput } from "./types/decision.js";

/**
 * The two halves of the decision template are enforced differently on purpose.
 *
 * The inputs are applied server-side and cannot be opted out of: "every
 * decision records why it was made" is a property of the record itself, and
 * language-neutral. The body sections are a writing convention this team holds
 * — the decision service is generic product infrastructure, so requiring
 * particular Chinese headings there would bind every future caller to one
 * team's prose. They are a client-side default instead: prefilled at proposal
 * time, freely reworded, never a reason a decision cannot be created.
 *
 * The proposer's rationale and the decider's rationale are deliberately one
 * field, not two — two invites a decision whose stated reason contradicts the
 * reason it was recommended for.
 */
export const DECISION_BODY_SECTIONS = ["背景", "判断标准", "方案"] as const;

/**
 * Collected at decide time and stored alongside the chosen option, so the
 * verdict and the reason for it are one record rather than two.
 */
export const DECISION_TEMPLATE_INPUTS: DecisionInput[] = [
  {
    id: "rationale",
    label: "裁决理由（必填，会连同选项一起写进决策历史）",
    placeholder: "为什么选这个。以后有人翻这条记录，看的就是这段。",
    required: true,
    maxLength: 2000,
  },
  {
    id: "constraints",
    label: "附加约束（选填）",
    placeholder: "实施时必须遵守的额外条件。留空表示没有。",
    required: false,
    maxLength: 1000,
  },
];

/** Prefilled when composing a proposal. Not validated server-side. */
export const DECISION_BODY_TEMPLATE = [
  "## 背景",
  "",
  "一两句，为什么现在要定这个。",
  "",
  "## 判断标准",
  "",
  "拿什么尺子量各个方案。缺了这段，裁决人只能凭感觉选。",
  "",
  "## 方案",
  "",
  "**A · …** —— 做法。",
  "*代价*：只写好处的方案等于在诱导。",
  "",
  "**B · …** —— 做法。",
  "*代价*：…",
].join("\n");

/**
 * Which template sections a body is missing. Advisory only — a composer can
 * use it to nudge, but the create path does not reject on it.
 */
export function missingDecisionBodySections(body: string): string[] {
  return DECISION_BODY_SECTIONS.filter(
    (section) => !new RegExp(`^#{1,6}\\s*[0-9.、]*\\s*${section}`, "m").test(body),
  );
}
