import type { Db } from "@paperclipai/db";

import type { EmbeddingConfig } from "./embedding-client.js";
import { secretService } from "./secrets.js";

/**
 * Configuration for the semantic leg of recall (MUL-441).
 *
 * Every knob lives here so the card can list them in one place, which Team
 * Rules requires of any new variable: a config value nobody wrote down is how a
 * terminal ended up running under someone else's identity for hours (MUL-113).
 *
 * | Variable                              | Where            | Consumed by            |
 * |---------------------------------------|------------------|------------------------|
 * | PAPERCLIP_RECALL_SEMANTIC             | env              | this module            |
 * | PAPERCLIP_RECALL_EMBEDDING_PROVIDER   | env              | this module            |
 * | PAPERCLIP_RECALL_EMBEDDING_MODEL      | env              | this module            |
 * | PAPERCLIP_RECALL_EMBEDDING_TIMEOUT_MS | env              | embedding-client       |
 * | PAPERCLIP_RECALL_EMBEDDING_BASE_URL   | env              | embedding-client       |
 * | recall-embedding-key                  | company_secrets  | this module            |
 *
 * The switch defaults to off. Turning it on without a key still leaves recall
 * working on its keyword leg — the semantic leg is an addition, never a
 * replacement, so an absent key is a normal state rather than an error.
 */

/** Company secret holding the embedding provider's API key. */
export const EMBEDDING_SECRET_NAME = "recall-embedding-key";

const DEFAULT_MODEL: Record<string, string> = {
  dashscope: "text-embedding-v4",
  openai: "text-embedding-3-small",
};

export interface ResolvedEmbeddingConfig extends EmbeddingConfig {
  /** Cache key component: vectors from different models are not comparable. */
  model: string;
}

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Whether the semantic leg is switched on at all. Cheap, no database access. */
export function semanticRecallEnabled(): boolean {
  return envFlag("PAPERCLIP_RECALL_SEMANTIC");
}

export function embeddingProvider(): EmbeddingConfig["provider"] {
  const raw = process.env.PAPERCLIP_RECALL_EMBEDDING_PROVIDER?.trim().toLowerCase();
  return raw === "openai" ? "openai" : "dashscope";
}

export function embeddingModel(): string {
  const explicit = process.env.PAPERCLIP_RECALL_EMBEDDING_MODEL?.trim();
  if (explicit) return explicit;
  return DEFAULT_MODEL[embeddingProvider()] ?? "text-embedding-v4";
}

/**
 * Resolves the full config for one company, or null when the semantic leg
 * cannot run.
 *
 * Null is not an error condition. It is returned when the switch is off, when
 * the company has not stored a key, and when the secret cannot be read — all
 * three mean the same thing to the caller: rank on keywords alone.
 */
export async function resolveEmbeddingConfig(
  db: Db,
  companyId: string,
): Promise<ResolvedEmbeddingConfig | null> {
  if (!semanticRecallEnabled()) return null;

  const secrets = secretService(db);
  const secret = await secrets.getByName(companyId, EMBEDDING_SECRET_NAME).catch(() => null);
  if (!secret) return null;

  let apiKey: string;
  try {
    apiKey = await secrets.resolveSecretValue(companyId, secret.id, "latest");
  } catch {
    // A key that cannot be decrypted is indistinguishable from no key, as far
    // as what recall should do about it.
    return null;
  }
  if (!apiKey) return null;

  const timeoutRaw = Number.parseInt(process.env.PAPERCLIP_RECALL_EMBEDDING_TIMEOUT_MS ?? "", 10);

  return {
    provider: embeddingProvider(),
    model: embeddingModel(),
    apiKey,
    baseUrl: process.env.PAPERCLIP_RECALL_EMBEDDING_BASE_URL?.trim() || undefined,
    timeoutMs: Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined,
  };
}
