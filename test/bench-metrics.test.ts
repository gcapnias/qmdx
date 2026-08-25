import { describe, expect, it } from "vitest";
import { AliasIndex, canonicalRanking, ndcgAt10 } from "../src/bench/canon.js";
import {
  evaluateRelevanceGate,
  familyBootstrapInterval,
  rankingDiagnostics,
} from "../src/bench/metrics.js";
import type { QueryEvaluation, RelevanceGrade, RunRecord } from "../src/bench/types.js";
import { cliArgsFor, isCacheContaminated, randomizedQueryOrder } from "../src/bench/runner.js";
import {
  buildValidCanonicalization,
  buildValidManifest,
} from "./helpers/bench-fixture.js";

const GRADES: Record<string, RelevanceGrade> = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => [
    `c-${String(index).padStart(2, "0")}`,
    ([3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0] as RelevanceGrade[])[index]!,
  ]),
);

/** Only three useful documents exist, so a perfect top-3 ranking scores 1. */
const SMALL_GRADES: Record<string, RelevanceGrade> = {
  "c-00": 3,
  "c-01": 2,
  "c-02": 2,
};

function evaluation(queryId: string, delta: number): QueryEvaluation {
  return {
    queryId,
    eligible: true,
    baselineNdcg10: 0.5,
    candidateNdcg10: 0.5 + delta,
    deltaNdcg10: delta,
    diagnostics: {
      baseline: { recallAt10: 1, mrrToFirstGrade2Or3: 1, successAt3: true, top10Grades: [] },
      candidate: { recallAt10: 1, mrrToFirstGrade2Or3: 1, successAt3: true, top10Grades: [] },
    },
  };
}

describe("canonical ranking", () => {
  const aliases = new AliasIndex(buildValidCanonicalization());

  it("collapses aliases to their best rank and backfills unique canonicals", () => {
    const ranking = canonicalRanking(
      [
        { docid: "doc-0", file: "qmd://corpus/doc-0.md" },
        { docid: "other", file: "qmd://x.md" },
        { docid: "doc-0-dup", file: "qmd://corpus/doc-0.md" },
        { docid: "doc-2", file: "qmd://corpus/doc-2.md" },
      ],
      aliases,
      10,
    );
    expect(ranking).toEqual(["c-00", "c-02"]);
  });

  it("honours the requested backfill depth", () => {
    const ranking = canonicalRanking(
      Array.from({ length: 6 }, (_, index) => ({
        docid: `doc-${index}`,
        file: `qmd://corpus/doc-${index}.md`,
      })),
      aliases,
      3,
    );
    expect(ranking).toEqual(["c-00", "c-01", "c-02"]);
  });
});

describe("canonical-document nDCG@10 with grade gains 0/1/3/7", () => {
  it("scores a perfect ranking at 1 and an inverted ranking lower", () => {
    expect(ndcgAt10(["c-00", "c-01", "c-02"], SMALL_GRADES)).toBeCloseTo(1);
    const inverted = ["c-02", "c-01", "c-00"];
    expect(ndcgAt10(inverted, SMALL_GRADES)!).toBeLessThan(1);
  });

  it("returns null when no judged document is relevant (nothing to improve)", () => {
    expect(ndcgAt10(["c-05"], { "c-05": 0 })).toBeNull();
  });

  it("treats unranked positions as gain 0 rather than failing", () => {
    expect(ndcgAt10([], GRADES)).toBe(0);
    expect(ndcgAt10(["c-03"], GRADES)).toBeGreaterThan(0);
    expect(ndcgAt10(["c-03"], GRADES)).toBeLessThan(0.2);
  });
});

describe("relevance gate arithmetic over the frozen 16-family structure", () => {
  const manifest = buildValidManifest();
  const families = manifest.families;
  const allQueryIds = families.flatMap((family) => family.queryIds);

  function gate(evaluations: QueryEvaluation[]) {
    return evaluateRelevanceGate({ queries: manifest.queries, families, evaluations, seed: 7 });
  }

  it("passes when magnitude and majority hold across every family", () => {
    const result = gate(allQueryIds.map((queryId) => evaluation(queryId, 0.1)));
    expect(result.eligibleQueryCount).toBe(20);
    expect(result.familyWeightedMeanDelta).toBeCloseTo(0.1);
    expect(result.familiesImproved).toBe(16);
    expect(result.magnitudePass).toBe(true);
    expect(result.majorityPass).toBe(true);
    expect(result.evaluation).toBe("gates-pass");
    expect(result.gateFailReasons).toHaveLength(0);
  });

  it("rejects on severe regression share above 20%", () => {
    const result = gate(
      allQueryIds.map((queryId, index) => evaluation(queryId, index < 5 ? -0.2 : 0.3)),
    );
    expect(result.regressionRate).toBeCloseTo(0.25);
    expect(result.regressionPass).toBe(false);
    expect(result.evaluation).toBe("gate-fail");
    expect(result.gateFailReasons.join("\n")).toMatch(/severe relevance regression/);
  });

  it("tolerates exactly-20% severe losses when everything else passes", () => {
    const result = gate(
      allQueryIds.map((queryId, index) => evaluation(queryId, index < 4 ? -0.11 : 0.2)),
    );
    expect(result.regressionRate).toBeCloseTo(0.2);
    expect(result.regressionPass).toBe(true);
    expect(result.evaluation).toBe("gates-pass");
  });

  it("fails the gate when aggregate relevance is zero or negative", () => {
    const result = gate(allQueryIds.map((queryId) => evaluation(queryId, 0)));
    expect(result.familyWeightedMeanDelta).toBe(0);
    expect(result.gateFailReasons.join("\n")).toMatch(/zero or negative/);
  });

  it("marks evidence incomplete when an eligibility failure empties a family", () => {
    const excluded = evaluation("h-07", 0);
    excluded.eligible = false;
    excluded.exclusionReason = "eligibility-failure";
    const result = gate([
      ...allQueryIds.filter((queryId) => queryId !== "h-07").map((queryId) => evaluation(queryId, 0.2)),
      excluded,
    ]);
    expect(result.familiesWithEligibleQueries).toBe(15);
    expect(result.evaluation).toBe("incomplete-evidence");
    expect(result.completenessIssues.join("\n")).toMatch(/excluded from the primary aggregate/);
  });

  it("flags positive-but-under-threshold results as inconclusive territory", () => {
    const result = gate(allQueryIds.map((queryId) => evaluation(queryId, 0.02)));
    expect(result.magnitudePass).toBe(false);
    expect(result.majorityPass).toBe(true);
    expect(result.evaluation).toBe("incomplete-evidence");
    expect(result.completenessIssues.join("\n")).toMatch(/inconclusive territory/);
  });

  it("flags the top-3 anchor regression rule", () => {
    const lost = evaluation("h-01", 0.1);
    lost.baselineTop3UsefulLostInCandidateTop10 = true;
    const result = gate([
      ...allQueryIds.filter((queryId) => queryId !== "h-01").map((queryId) => evaluation(queryId, 0.2)),
      lost,
    ]);
    expect(result.top3AnchorPass).toBe(false);
    expect(result.evaluation).toBe("gate-fail");
    expect(result.gateFailReasons.join("\n")).toMatch(/no grade-2\/3 document in the QMDX top 10/);
  });
});

describe("diagnostic reports", () => {
  it("computes Recall@10, MRR to first grade-2/3, and Success@3", () => {
    const diagnostics = rankingDiagnostics(["c-05", "c-04", "c-03", "c-00"], GRADES);
    expect(diagnostics.successAt3).toBe(false);
    expect(diagnostics.mrrToFirstGrade2Or3).toBeCloseTo(0.25);
    expect(diagnostics.recallAt10).toBeCloseTo(1 / 3);

    const better = rankingDiagnostics(["c-03", "c-01", "c-00"], GRADES);
    expect(better.successAt3).toBe(true);
    expect(better.mrrToFirstGrade2Or3).toBeCloseTo(0.5);
    expect(better.recallAt10).toBeCloseTo(2 / 3);
  });

  it("derives a deterministic topic-family bootstrap interval", () => {
    const first = familyBootstrapInterval([0.1, 0.2, 0.3, 0.4], 99);
    const second = familyBootstrapInterval([0.1, 0.2, 0.3, 0.4], 99);
    expect(first).toEqual(second);
    expect(first.low).toBeLessThanOrEqual(first.high);
  });
});

describe("cache-hit filtering", () => {
  function runRecord(overrides: Partial<RunRecord>): RunRecord {
    return {
      variant: "candidate",
      queryId: "h-01",
      argv: [],
      exitCode: 0,
      wallMs: 100,
      window: "window-1",
      repeatIndex: 0,
      stdout: "",
      stderr: "",
      cacheHit: false,
      cacheStates: { expansion: "absent", reranking: "absent" },
      ...overrides,
    };
  }

  it("excludes runs where either remote stage was served from cache", () => {
    expect(isCacheContaminated(runRecord({}))).toBe(false);
    expect(
      isCacheContaminated(
        runRecord({ cacheHit: true, cacheStates: { expansion: "hit", reranking: "absent" } }),
      ),
    ).toBe(true);
  });
});

describe("run protocol helpers", () => {
  it("builds baseline invocations through the public CLI with both stages disabled", () => {
    expect(cliArgsFor({ variant: "baseline", queryText: "q", outputDepth: 20, profileName: null })).toEqual([
      "query",
      "q",
      "--format",
      "json",
      "--explain",
      "-n",
      "20",
      "--no-expand",
      "--no-rerank",
    ]);
  });

  it("routes candidate invocations through the frozen profile", () => {
    const args = cliArgsFor({
      variant: "candidate",
      queryText: "q",
      outputDepth: 20,
      profileName: "bench-candidate",
    });
    expect(args).toContain("--profile");
    expect(args).toContain("bench-candidate");
    expect(args).not.toContain("--no-expand");
  });

  it("randomizes deterministically for a given seed", () => {
    const queries = Array.from({ length: 20 }, (_, index) => ({
      id: `q${index}`,
      text: `t${index}`,
      slice: "headline" as const,
      provenanceRef: "ledger",
      intentStatement: "i",
      familyId: `f${index}`,
    }));
    const first = randomizedQueryOrder(queries, 42).map((query) => query.id);
    const second = randomizedQueryOrder(queries, 42).map((query) => query.id);
    expect(first).toEqual(second);
    expect([...first].sort()).toEqual(queries.map((query) => query.id).sort());
    expect(first).not.toEqual(queries.map((query) => query.id));
  });
});
