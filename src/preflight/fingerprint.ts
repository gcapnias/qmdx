import { createHash } from "node:crypto";
import type { RateCardEntry } from "../core/pricing.js";

/**
 * Bumped whenever the live capability-check contract changes in an
 * outcome-affecting way, so every previously recorded check invalidates.
 */
export const PREFLIGHT_CAPABILITY_VERSION = 1;

export interface RouteFingerprintFields {
  provider: string;
  endpoint: string;
  model: string;
  credentialEnv: string;
}

export interface ProfileFingerprintInput {
  expansion: RouteFingerprintFields;
  reranking: RouteFingerprintFields;
  expansionPricing: RateCardEntry | null;
  rerankingPricing: RateCardEntry | null;
  privacyDeclarationFingerprint: string;
}

/** Deterministic JSON serialization with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Content fingerprint of everything whose change must invalidate the live
 * checks and the approval: both routes (provider, endpoint, model,
 * credential reference), the reviewed pricing entries for their models, and
 * the versioned privacy declaration.
 */
export function computeProfilePreflightFingerprint(
  input: ProfileFingerprintInput,
): string {
  return sha256Hex(
    stableStringify({
      capabilityVersion: PREFLIGHT_CAPABILITY_VERSION,
      expansion: input.expansion,
      reranking: input.reranking,
      expansionPricing: input.expansionPricing,
      rerankingPricing: input.rerankingPricing,
      privacy: input.privacyDeclarationFingerprint,
    }),
  );
}
