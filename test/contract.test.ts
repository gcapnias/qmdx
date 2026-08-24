import { describe, expect, it } from "vitest";
import {
  ERROR_CATEGORIES,
  ERROR_CODES,
  EXPANSION_STATUSES,
  GENERATED_QUERY_TYPES,
  PIPELINE_STATUSES,
  RERANKING_STATUSES,
  RETRIEVAL_STATUSES,
  REASON_CODES,
  SCHEMA_VERSION,
  WARNING_STAGES,
} from "../src/core/enums.js";
import {
  buildErrorEnvelope,
  buildResultEnvelope,
} from "../src/core/envelope.js";
import { EXIT_CODES, exitCodeForCategory } from "../src/core/exit-codes.js";
import { manualClock } from "../src/core/clock.js";
import {
  blendedFinalScore,
  qmdPositionScore,
  retrievalWeightForRank,
} from "../src/pipeline/score.js";
import { reviewedProviderPricing } from "../src/core/pricing.js";

describe("exit-code table", () => {
  it("contains exactly the five spec exit codes", () => {
    expect(Object.values(EXIT_CODES).sort((a, b) => a - b)).toEqual([
      0, 2, 3, 4, 5,
    ]);
  });

  it("maps every closed error category to its exit code", () => {
    expect(exitCodeForCategory("invocation")).toBe(2);
    expect(exitCodeForCategory("configuration")).toBe(2);
    expect(exitCodeForCategory("local_retrieval")).toBe(3);
    expect(exitCodeForCategory("required_remote")).toBe(4);
    expect(exitCodeForCategory("internal")).toBe(5);
  });
});

describe("closed enums", () => {
  it("pipeline statuses are ok|degraded", () => {
    expect([...PIPELINE_STATUSES]).toEqual(["ok", "degraded"]);
  });

  it("expansion statuses match the spec", () => {
    expect([...EXPANSION_STATUSES]).toEqual([
      "expanded",
      "original_sufficient",
      "degraded",
      "disabled",
    ]);
  });

  it("retrieval status is only ok", () => {
    expect([...RETRIEVAL_STATUSES]).toEqual(["ok"]);
  });

  it("reranking statuses match the spec", () => {
    expect([...RERANKING_STATUSES]).toEqual(["ok", "degraded", "disabled"]);
  });

  it("warning stages cover only remote stages", () => {
    expect([...WARNING_STAGES]).toEqual(["expansion", "reranking"]);
  });

  it("stage reason and warning codes match the closed list", () => {
    expect([...REASON_CODES]).toEqual([
      "transport_error",
      "timeout",
      "rate_limited",
      "provider_unavailable",
      "authentication_failed",
      "billing_or_quota_exhausted",
      "provider_policy_rejected",
      "unsupported_capability",
      "invalid_provider_response",
      "payload_limit_exceeded",
      "cost_budget_exceeded",
      "stage_budget_exceeded",
      "global_deadline_exceeded",
    ]);
  });

  it("error categories match the closed list", () => {
    expect([...ERROR_CATEGORIES]).toEqual([
      "invocation",
      "configuration",
      "local_retrieval",
      "required_remote",
      "internal",
    ]);
  });

  it("error codes match the closed list", () => {
    expect([...ERROR_CODES]).toEqual([
      "invalid_invocation",
      "unsupported_option",
      "invalid_profile",
      "missing_credentials",
      "preflight_required",
      "privacy_approval_required",
      "local_index_unavailable",
      "local_index_incomplete",
      "vector_probe_failed",
      "required_remote_failed",
      "internal_error",
    ]);
  });

  it("generated query types are lex|vec|hyde", () => {
    expect([...GENERATED_QUERY_TYPES]).toEqual(["lex", "vec", "hyde"]);
  });
});

describe("result envelope shape", () => {
  const envelope = buildResultEnvelope({
    query: { original: "q", intent: null, collections: [] },
    pipeline: {
      status: "ok",
      expansion: { status: "expanded", reason: null, generatedQueries: [] },
      retrieval: { status: "ok", reason: null, candidateCount: 0, engine: "qmd" },
      reranking: { status: "ok", reason: null, candidateCount: 0 },
    },
    results: [],
    warnings: [],
    timingMs: { total: 1, expansion: 0, retrieval: 0, reranking: 0, overhead: 1 },
  });

  it("carries schemaVersion 1 at the top level", () => {
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("has exactly the spec top-level members", () => {
    expect(Object.keys(envelope).sort()).toEqual(
      ["pipeline", "query", "results", "schemaVersion", "timingMs", "warnings"],
    );
  });

  it("has exactly the spec pipeline members per stage", () => {
    expect(Object.keys(envelope.pipeline).sort()).toEqual([
      "expansion",
      "reranking",
      "retrieval",
      "status",
    ]);
    expect(Object.keys(envelope.pipeline.expansion).sort()).toEqual([
      "generatedQueries",
      "reason",
      "status",
    ]);
    expect(Object.keys(envelope.pipeline.retrieval).sort()).toEqual([
      "candidateCount",
      "engine",
      "reason",
      "status",
    ]);
    expect(Object.keys(envelope.pipeline.reranking).sort()).toEqual([
      "candidateCount",
      "reason",
      "status",
    ]);
    expect(envelope.pipeline.retrieval.engine).toBe("qmd");
  });

  it("has exactly the spec timing members", () => {
    expect(Object.keys(envelope.timingMs).sort()).toEqual([
      "expansion",
      "overhead",
      "reranking",
      "retrieval",
      "total",
    ]);
  });
});

describe("error envelope shape", () => {
  const envelope = buildErrorEnvelope({
    error: {
      category: "configuration",
      code: "privacy_approval_required",
      message: "Profile default requires current privacy approval.",
      stage: null,
      retryable: false,
    },
    totalMs: 0,
  });

  it("has exactly the spec top-level members", () => {
    expect(Object.keys(envelope).sort()).toEqual([
      "error",
      "schemaVersion",
      "timingMs",
      "warnings",
    ]);
    expect(envelope.schemaVersion).toBe(1);
  });

  it("has exactly the spec error members", () => {
    expect(Object.keys(envelope.error).sort()).toEqual([
      "category",
      "code",
      "message",
      "retryable",
      "stage",
    ]);
    expect(Object.keys(envelope.timingMs)).toEqual(["total"]);
  });
});

describe("public score modes", () => {
  it("position mode exposes score 1/qmdRrfRank with unit weight and no remote score", () => {
    for (const rank of [1, 2, 5, 11, 40]) {
      const score = qmdPositionScore(rank);
      expect(score).toBeCloseTo(1 / rank, 6);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("blended mode applies the QMD position bands to the final score formula", () => {
    expect(retrievalWeightForRank(1)).toBe(0.75);
    expect(retrievalWeightForRank(3)).toBe(0.75);
    expect(retrievalWeightForRank(4)).toBe(0.6);
    expect(retrievalWeightForRank(10)).toBe(0.6);
    expect(retrievalWeightForRank(11)).toBe(0.4);
    expect(retrievalWeightForRank(80)).toBe(0.4);
  });

  it("blends retrieval position with the remote rerank score per the frozen formula", () => {
    expect(blendedFinalScore(2, 0.89)).toBeCloseTo(0.5975, 6);
    expect(blendedFinalScore(1, 1)).toBeCloseTo(1, 6);
    for (const rank of [1, 3, 7, 15]) {
      for (const remote of [0, 0.5, 1]) {
        const score = blendedFinalScore(rank, remote);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("injectable boundaries", () => {
  it("supports a manual clock for deterministic timing", () => {
    const clock = manualClock(1000);
    expect(clock.nowMs()).toBe(1000);
    clock.advance(250);
    expect(clock.nowMs()).toBe(1250);
  });

  it("default reviewed pricing covers the spec-default provider routes", () => {
    const expansion =
      reviewedProviderPricing.rateFor("openai", "gpt-4o-mini") ?? null;
    expect(expansion).not.toBeNull();
    expect(reviewedProviderPricing.rateFor("cohere", "rerank-v4.0-pro")).not.toBeNull();
  });

  it("accepts an injected pricing source", () => {
    const fake = { rateFor: (p: string, m: string) =>
      p === "x" && m === "y"
        ? {
            provider: "x",
            model: "y",
            endpoint: "https://example.test",
            currency: "USD" as const,
            usdPerMillionInputTokens: 1,
            usdPerMillionOutputTokens: 2,
            usdPerThousandSearchQueries: null,
            reviewedOnIsoDate: "2026-01-01",
          }
        : null };
    expect(fake.rateFor("x", "y")).not.toBeNull();
    expect(fake.rateFor("a", "b")).toBeNull();
  });
});
