/**
 * A decision-effect comment is the verdict line the decide flow files back on
 * the origin issue — platform-generated on the deciding agent's behalf, never
 * the agent's own words. New rows carry presentation.kind=decision_effect;
 * rows filed before MUL-153 are recognized by the body shape so the whole
 * history reads the same way.
 */
const DECISION_VERDICT_RE = /^决策「.+」：/;

export function isDecisionEffectComment(comment: {
  body?: string | null;
  presentation?: { kind?: string } | null;
}): boolean {
  if (comment.presentation?.kind === "decision_effect") return true;
  const body = comment.body?.trim() ?? "";
  return body.startsWith("决策「") && DECISION_VERDICT_RE.test(body);
}
