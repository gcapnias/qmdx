import type { EffectiveRoute } from "../config/resolve.js";
import { sha256Hex, stableStringify } from "../preflight/fingerprint.js";
import {
  CACHE_IDENTITY_VERSION,
  type StageCacheBinding,
} from "../core/cache.js";
import {
  EXPANSION_RESPONSE_JSON_SCHEMA,
  EXPANSION_SAMPLING,
  EXPANSION_SCHEMA_NAME,
  EXPANSION_SYSTEM_PROMPT,
} from "./schema.js";

/**
 * Expansion cache identity (docs/spec/qmdx-v1.md, "Caching and
 * diagnostics"): the exact stage input plus provider, endpoint, model,
 * prompt/schema identity, privacy declaration, and policy versions.
 */

/**
 * Content fingerprint of the frozen prompt, schema name/schema, and
 * sampling settings; any edit produces a new value and invalidates entries.
 */
export function expansionPromptSchemaFingerprint(): string {
  return sha256Hex(
    stableStringify({
      name: EXPANSION_SCHEMA_NAME,
      prompt: EXPANSION_SYSTEM_PROMPT,
      schema: EXPANSION_RESPONSE_JSON_SCHEMA,
      sampling: EXPANSION_SAMPLING,
    }),
  );
}

/** Bumped whenever the expansion request contract changes. */
export const EXPANSION_REQUEST_POLICY_VERSION = 1;

export function expansionCacheIdentity(
  route: EffectiveRoute,
  binding: StageCacheBinding,
  admittedQuery: string,
): string {
  return sha256Hex(
    stableStringify({
      identityVersion: CACHE_IDENTITY_VERSION,
      stage: "expansion",
      provider: route.provider,
      endpoint: route.endpoint,
      model: route.model,
      promptSchemaFingerprint: expansionPromptSchemaFingerprint(),
      privacyDeclarationFingerprint: binding.privacyFingerprint,
      policyVersion: EXPANSION_REQUEST_POLICY_VERSION,
      input: { plainQuery: admittedQuery },
    }),
  );
}
