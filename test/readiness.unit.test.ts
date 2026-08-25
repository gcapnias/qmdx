import { describe, expect, it } from "vitest";
import type { QMDStore } from "@tobilu/qmd";
import { validateIndexReadiness } from "../src/qmd/readiness.js";
import type { OpenedProjectStore } from "../src/qmd/store.js";

/**
 * Unit coverage for the vector-probe readiness gate: a zero-retrieval probe
 * must fail whenever the index is otherwise complete and non-empty —
 * including the ≤10% coverage-warning path (docs/spec/qmdx-v1.md, local
 * index contract step 7).
 */

interface FakeStatus {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
}

function fakeOpened(
  status: FakeStatus,
  probeBehavior: () => Promise<Array<unknown>>,
): OpenedProjectStore {
  const store = {
    getStatus: async () => status,
    searchVector: probeBehavior,
    getIndexHealth: async () => ({ daysStale: 0 }),
  } as unknown as QMDStore;
  return {
    store,
    embedModel: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    multilingualDefault: true,
  };
}

describe("vector-probe readiness gate", () => {
  it("fails a zero-retrieval probe on a fully complete index", async () => {
    const opened = fakeOpened(
      { totalDocuments: 5, needsEmbedding: 0, hasVectorIndex: true },
      async () => [],
    );
    await expect(validateIndexReadiness(opened)).rejects.toMatchObject({
      category: "local_retrieval",
      code: "vector_probe_failed",
    });
  });

  it("fails a zero-retrieval probe even when only the ≤10% coverage warning applies", async () => {
    // 2 of 20 = 10%: passes the coverage gate with a warning, but the probe
    // still proves nothing retrievable.
    const opened = fakeOpened(
      { totalDocuments: 20, needsEmbedding: 2, hasVectorIndex: true },
      async () => [],
    );
    await expect(validateIndexReadiness(opened)).rejects.toMatchObject({
      code: "vector_probe_failed",
      message: expect.stringContaining(
        "retrieved no results from an otherwise complete, non-empty index",
      ),
    });
  });

  it("reports ok with the coverage warning when the probe retrieves", async () => {
    const opened = fakeOpened(
      { totalDocuments: 20, needsEmbedding: 2, hasVectorIndex: true },
      async () => [{ file: "qmd://docs/doc-1.md" }],
    );
    const report = await validateIndexReadiness(opened);
    expect(report.probeResults).toBe(1);
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      "embedding_coverage_incomplete",
    ]);
  });
});
