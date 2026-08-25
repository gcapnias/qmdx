import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";
import { internalError } from "../core/errors.js";

export const CANDIDATE_POOL_SIZE = 80;

export interface CandidatePoolRequest {
  originalQuery: string;
  intent: string | null;
  collections: string[];
}


export function originalRetrievalRoutes(
  originalQuery: string,
): ExpandedQuery[] {
  return [{ type: "lex", query: originalQuery }];
}

export async function fetchCandidatePool(
  store: QMDStore,
  request: CandidatePoolRequest,
  routes: ExpandedQuery[] = originalRetrievalRoutes(request.originalQuery),
): Promise<HybridQueryResult[]> {
  try {
    return await store.search({
      queries: routes,
      collections: request.collections.length > 0 ? request.collections : undefined,
      rerank: false,
      candidateLimit: CANDIDATE_POOL_SIZE,
      limit: CANDIDATE_POOL_SIZE,
      minScore: 0,
      explain: true,
      intent: request.intent ?? undefined,
    });
  } catch (cause) {
    throw internalError(
      `QMD local retrieval failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    );
  }
}
