import { sessionLocatorForSlug, type TerminalSlug } from "./session-locator.js";

/**
 * How a model and its reasoning effort are written wherever a reader has to
 * judge a conclusion later (MUL-444).
 *
 * MUL-22 already required the model name on a decision card, because the
 * system header records no model and, when someone reopens an old decision, the
 * model is the main thing that says how much to trust it. Effort is the other
 * half: the same model at low effort and at high effort are not the same
 * answer, so recording only the name records only half the fact.
 *
 * Every value here was read off this machine on 2026-08-31 rather than copied
 * from a spec, and three of the four disagreed with the shapes the card
 * originally assumed — see MODEL_ALIASES and the Codex note below.
 */

/**
 * Internal model codes to the names people use. Only Qoder needs this today:
 * its transcript records `qmodel_38max`, which names nothing to a reader.
 *
 * This table is maintenance debt by construction — it goes stale when the
 * harness ships a new model — so an unknown code falls through as itself
 * rather than being guessed at or dropped. A raw code in the UI is a visible
 * prompt to add a row; a silently blank model is not.
 */
export const MODEL_ALIASES: Record<string, string> = {
  qmodel_38max: "Qwen-3.8 Max",
};

export function displayModelName(raw: string | null | undefined, naming: "verbatim" | "alias"): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (naming === "verbatim") return value;
  return MODEL_ALIASES[value] ?? value;
}

export interface ModelSignature {
  /** Terminal the work ran on, or null when it was not a terminal agent. */
  slug: TerminalSlug | null;
  model: string | null;
  effort: string | null;
}

/**
 * The one line that goes on a decision card, a discussion bubble and a document
 * revision.
 *
 * Per-harness shapes, because each community writes its own model differently
 * and inventing a uniform shape would make every one of them wrong:
 *
 *   Claude   `Claude Opus 5 + high`      name and effort joined with +
 *   Codex    `gpt-5.6-terra-high`        hyphenated, the way Codex names runs
 *   Zcode    `Zcode GLM-5.3`             prefixed, effort appended when known
 *   Qoder    `Qoder Qwen-3.8 Max`        prefixed, alias-resolved
 *
 * Note the Codex shape: the recorded model is `gpt-5.6-terra`, so the joined
 * form is `gpt-5.6-terra-high`. The card originally specified `gpt-5.6-high`,
 * which is not a value this machine ever produced.
 *
 * Returns null when there is no model to show. Callers render "未记录" rather
 * than guessing, so a gap in collection stays visible instead of being papered
 * over with a plausible-looking name.
 */
export function formatModelSignature(signature: ModelSignature): string | null {
  const model = signature.model?.trim();
  if (!model) return null;
  const effort = signature.effort?.trim() || null;

  switch (signature.slug) {
    case "claude-terminal":
      return effort ? `${model} + ${effort}` : model;
    case "codex-terminal":
      return effort ? `${model}-${effort}` : model;
    case "zcode-terminal": {
      const base = model.startsWith("Zcode") ? model : `Zcode ${model}`;
      return effort ? `${base} + ${effort}` : base;
    }
    case "qoder": {
      const base = model.startsWith("Qoder") ? model : `Qoder ${model}`;
      return effort ? `${base} + ${effort}` : base;
    }
    default:
      return effort ? `${model} + ${effort}` : model;
  }
}

/** Resolve the raw recorded values into the display line for a terminal. */
export function modelSignatureFor(
  slug: string | null | undefined,
  rawModel: string | null | undefined,
  rawEffort: string | null | undefined,
): string | null {
  const locator = sessionLocatorForSlug(slug);
  const model = displayModelName(rawModel, locator?.modelNaming ?? "verbatim");
  return formatModelSignature({ slug: (locator?.slug ?? null), model, effort: rawEffort ?? null });
}
