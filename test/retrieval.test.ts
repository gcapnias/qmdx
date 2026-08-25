import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";
import { describe, expect, it } from "vitest";
import { CANDIDATE_POOL_SIZE, fetchCandidatePool } from "../src/qmd/retrieval.js";

function storeWithSearch(results: HybridQueryResult[]) {
  const calls: Array<Record<string, unknown>> = [];
  const store = {
    async search(request: Record<string, unknown>) {
      calls.push(request);
      return results;
    },
  } as unknown as QMDStore;
  return { store, calls };
}

describe("fetchCandidatePool", () => {
  const routes: ExpandedQuery[] = [{ type: "lex", query: "embeddings" }];

  it("forwards explicit collection filters to QMD search", async () => {
    const results: HybridQueryResult[] = [];
    const { store, calls } = storeWithSearch(results);

    const found = await fetchCandidatePool(store, {
      originalQuery: "embeddings",
      intent: null,
      collections: ["docs"],
    }, routes);

    expect(found).toBe(results);
    expect(calls).toEqual([{
      queries: routes,
      collections: ["docs"],
      rerank: false,
      candidateLimit: CANDIDATE_POOL_SIZE,
      limit: CANDIDATE_POOL_SIZE,
      minScore: 0,
      explain: true,
      intent: undefined,
    }]);
  });
});
