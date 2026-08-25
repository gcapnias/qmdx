import type { EffectiveRoute } from "../config/resolve.js";
import { sha256Hex, stableStringify } from "../preflight/fingerprint.js";
import {
  CACHE_IDENTITY_VERSION,
  type StageCacheBinding,
} from "../core/cache.js";

/**
 * Reranking cache identity (docs/spec/qmdx-v1.md, "Caching and
 * diagnostics"): the stage inputs as hashes plus provider, endpoint, model,
 * prompt/schema identity, privacy declaration, and policy versions — and,
 * additionally, the ORDERED candidate identities and selected-chunk hashes.
 * Chunks themselves are never stored, only their hashes.
 */

/** Bumped whenever the reranking request contract changes. */
export const RERANK_REQUEST_POLICY_VERSION = 1;

export function rerankCacheIdentity(
  route: EffectiveRoute,
  binding: StageCacheBinding,
  rerankingQuery: string,
  documents: ReadonlyArray<{ identity: string; chunk: string }>,
): string {
  return sha256Hex(
    stableStringify({
      identityVersion: CACHE_IDENTITY_VERSION,
      stage: "reranking",
      provider: route.provider,
      endpoint: route.endpoint,
      model: route.model,
      requestPolicyVersion: RERANK_REQUEST_POLICY_VERSION,
      privacyDeclarationFingerprint: binding.privacyFingerprint,
      queryHash: sha256Hex(rerankingQuery),
      // Ordered identities AND chunk hashes: a reordered pool or an edited
      // selected chunk is a different remote request.
      candidates: documents.map((doc) => ({
        identity: doc.identity,
        chunkHash: sha256Hex(doc.chunk),
      })),
    }),
  );
}
