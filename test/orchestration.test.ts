import { describe, expect, it } from "vitest";
import type { HybridQueryResult } from "@tobilu/qmd";
import { manualClock, type ManualClock } from "../src/core/clock.js";
import type {
  EffectiveProfile,
  EffectiveRoute,
} from "../src/config/resolve.js";
import type { ExpandTransport } from "../src/expand/openai.js";
import type { RerankTransport } from "../src/rerank/cohere.js";
import { runQuery, type QueryRequest } from "../src/pipeline/search.js";
import type { SearchDeps } from "../src/pipeline/search.js";
import type { ProviderPricingSource } from "../src/core/pricing.js";

/**
 * Orchestrator-level bounded-search behavior (#12): cumulative budgets,
 * global-deadline cancellation, retry backoff, rate limiting, and envelope
 * metadata — all under a deterministic manual clock where every simulated
 * latency and backoff wait advances the clock synchronously.
 */

const EXPANSION_ROUTE: EffectiveRoute = {
  stage: "expansion",
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-4o-mini",
  credentialEnv: "QMDX_TEST_EXPANSION_KEY",
};

const RERANKING_ROUTE: EffectiveRoute = {
  stage: "reranking",
  provider: "cohere",
  endpoint: "https://api.cohere.example",
  model: "rerank-v4.0-pro",
  credentialEnv: "QMDX_TEST_RERANKING_KEY",
};

const ENV = {
  QMDX_TEST_EXPANSION_KEY: "pipeline-secret-key",
  QMDX_TEST_RERANKING_KEY: "pipeline-secret-key",
};

const PROFILE: EffectiveProfile = {
  name: "test",
  expansion: EXPANSION_ROUTE,
  reranking: RERANKING_ROUTE,
};

function poolEntry(rank: number): HybridQueryResult {
  return {
    file: `qmd://docs/doc-${rank}.md`,
    displayPath: `doc-${rank}.md`,
    title: `Title ${rank}`,
    body: `BODY ${rank}`,
    bestChunk: `CHUNK ${rank}`,
    bestChunkPos: rank,
    context: null,
    score: 1 / rank,
    docid: String(100000 + rank),
    explain: {
      ftsScores: [],
      vectorScores: [],
      rrf: {
        rank,
        positionScore: 1 / rank,
        weight: 1,
        baseScore: 0,
        topRankBonus: 0,
        totalScore: 1 / rank,
        contributions: [],
      },
      rerankScore: 0,
      blendedScore: 1 / rank,
    },
  } as HybridQueryResult;
}

const POOL = [poolEntry(1), poolEntry(2), poolEntry(3)];

function baseRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    originalQuery: "find things",
    plainQuery: "find things",
    routes: [],
    intent: null,
    collections: [],
    limit: 80,
    minScore: null,
    full: false,
    explain: false,
    noExpand: false,
    noRerank: false,
    ...overrides,
  };
}

function expandOk(usage?: unknown): unknown {
  return {
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          outcome: "expanded",
          queries: [{
            type: "lex",
            query: "generated terminology",
            language: "en",
            purpose: "terminology",
          }],
        }),
      },
    }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function rerankOk(docCount: number, score = 0.9): unknown {
  return {
    id: "resp-1",
    results: Array.from({ length: docCount }, (_, index) => ({
      index,
      relevance_score: score,
    })),
  };
}

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Simulated provider latency: advances the manual clock. */
  advanceMs?: number;
}

type StageName = "expansion" | "reranking";

interface Harness {
  clock: ManualClock;
  transport: ExpandTransport & RerankTransport & {
    calls: Array<{ stage: StageName }>;
  };
  sleeps: number[];
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * One fake transport serves both remote stages (the HTTP response shapes are
 * structurally identical). Every simulated latency and backoff wait advances
 * the shared manual clock, keeping the whole search deterministic.
 */
function harness(
  handler: (stage: StageName, attempt: number) => FakeResponse,
  rng: () => number = () => 0.99,
): Harness {
  const clock = manualClock(0);
  const sleeps: number[] = [];
  const calls: Array<{ stage: StageName }> = [];
  const transport = (async (url: string, _init: { body: string }) => {
    const stage: StageName = url.includes("/chat/completions")
      ? "expansion"
      : "reranking";
    const attempt = calls.filter((call) => call.stage === stage).length + 1;
    calls.push({ stage });
    const response = handler(stage, attempt);
    if (response.advanceMs !== undefined) clock.advance(response.advanceMs);
    return {
      status: response.status,
      headers: response.headers ?? {},
      json: async () => response.body,
    };
  }) as unknown as ExpandTransport & RerankTransport & {
    calls: Array<{ stage: StageName }>;
  };
  Object.assign(transport, { calls });
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  return { clock, transport, sleeps, rng, sleep };
}

function deps(harnessResult: Harness, overrides: Partial<SearchDeps> = {}): SearchDeps {
  return {
    clock: harnessResult.clock,
    effectiveProfile: PROFILE,
    env: ENV,
    transport: harnessResult.transport,
    rng: harnessResult.rng,
    sleep: harnessResult.sleep,
    fetchPool: async () => POOL,
    ...overrides,
  };
}

describe("cumulative stage budget expiry", () => {
  it("refuses the retry when the expansion stage budget is exhausted", async () => {
    const h = harness((_stage, attempt) =>
      attempt === 1
        ? { status: 503, advanceMs: 8_100 }
        : { status: 200, body: expandOk() }
    );
    const outcome = await runQuery(baseRequest({ noRerank: true }), deps(h));
    const { expansion } = outcome.envelope.pipeline;
    expect(expansion.status).toBe("degraded");
    expect(expansion.reason).toBe("stage_budget_exceeded");
    // The first attempt consumed the whole 8 s budget; the retry never starts.
    expect(h.transport.calls.filter((c) => c.stage === "expansion")).toHaveLength(1);
    expect(expansion.metadata).toMatchObject({ attempts: 1, retries: 0 });
    expect(expansion.metadata.costUsd).toBeGreaterThan(0);
    // The search itself stays usable (QMD baseline).
    expect(outcome.envelope.results).toHaveLength(3);
    expect(outcome.envelope.warnings[0]).toMatchObject({
      stage: "expansion",
      code: "stage_budget_exceeded",
      retryable: false,
    });
  });

  it("refuses the retry when the reranking stage budget is exhausted", async () => {
    const h = harness((stage, attempt) =>
      stage === "expansion"
        ? { status: 200, body: expandOk() }
        : attempt === 1
        ? { status: 503, advanceMs: 12_100 }
        : { status: 200, body: rerankOk(POOL.length) }
    );
    const outcome = await runQuery(baseRequest(), deps(h));
    const { reranking } = outcome.envelope.pipeline;
    expect(reranking.status).toBe("degraded");
    expect(reranking.reason).toBe("stage_budget_exceeded");
    expect(h.transport.calls.filter((c) => c.stage === "reranking")).toHaveLength(1);
    expect(reranking.metadata).toMatchObject({ attempts: 1, retries: 0 });
    expect(outcome.envelope.results).toHaveLength(3);
  });
});

describe("hard end-to-end deadline", () => {
  it("cancels reranking without transmission when expansion consumed the deadline", async () => {
    const h = harness((stage) =>
      stage === "expansion"
        ? { status: 200, body: expandOk(), advanceMs: 30_100 }
        : { status: 200, body: rerankOk(POOL.length) }
    );
    const outcome = await runQuery(baseRequest(), deps(h));
    const { pipeline, results, warnings } = outcome.envelope;
    expect(pipeline.reranking.status).toBe("degraded");
    expect(pipeline.reranking.reason).toBe("global_deadline_exceeded");
    expect(pipeline.reranking.metadata).toEqual({
      attempts: 0,
      retries: 0,
      costUsd: 0,
    });
    expect(h.transport.calls.filter((c) => c.stage === "reranking")).toHaveLength(0);
    expect(warnings.some((w) =>
      w.stage === "reranking" && w.code === "global_deadline_exceeded"
    )).toBe(true);
    expect(pipeline.status).toBe("degraded");
    // Usable QMD baseline despite the cancellation.
    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBeCloseTo(1, 6);
  });

  it("cancels an in-flight reranking retry once the deadline passes mid-stage", async () => {
    const h = harness((stage, attempt) =>
      stage === "expansion"
        ? { status: 200, body: expandOk(), advanceMs: 28_000 }
        : attempt === 1
        ? { status: 503, advanceMs: 2_500 }
        : { status: 200, body: rerankOk(POOL.length) }
    );
    const outcome = await runQuery(baseRequest(), deps(h));
    const report = outcome.envelope.pipeline.reranking;
    expect(report.status).toBe("degraded");
    expect(report.reason).toBe("global_deadline_exceeded");
    // Exactly one attempt was made; the stage was cancelled, not completed.
    expect(report.metadata).toMatchObject({ attempts: 1, retries: 0 });
    expect(h.transport.calls.filter((c) => c.stage === "reranking")).toHaveLength(1);
    expect(outcome.envelope.results).toHaveLength(3);
  });

  it("keeps local retrieval a distinct failure category even after deadline pressure", async () => {
    const h = harness(() => ({ status: 200, body: expandOk(), advanceMs: 29_000 }));
    await expect(runQuery(baseRequest(), deps(h, {
      fetchPool: () => {
        throw new Error("local store exploded");
      },
    }))).rejects.toThrowError("local store exploded");
    // The failure escaped as a local error; no degraded envelope was produced.
  });
});

describe("retry backoff and rate limiting", () => {
  it("honors Retry-After when it fits the remaining budgets", async () => {
    const h = harness((stage, attempt) =>
      stage === "expansion"
        ? { status: 200, body: expandOk() }
        : attempt === 1
        ? { status: 429, headers: { "retry-after": "2" } }
        : { status: 200, body: rerankOk(POOL.length) }
    );
    const outcome = await runQuery(baseRequest({ noExpand: true }), deps(h));
    const { reranking } = outcome.envelope.pipeline;
    expect(reranking.status).toBe("ok");
    expect(h.sleeps).toEqual([2000]);
    expect(reranking.metadata).toMatchObject({ attempts: 2, retries: 1 });
    expect(reranking.metadata.costUsd).toBeGreaterThan(0);
  });

  it("rate limiting that survives the single retry degrades with rate_limited", async () => {
    const h = harness(
      (stage) =>
        stage === "expansion" ? { status: 200, body: expandOk() } : { status: 429 },
      () => 0.5,
    );
    const outcome = await runQuery(baseRequest({ noExpand: true }), deps(h));
    const { reranking } = outcome.envelope.pipeline;
    const { warnings } = outcome.envelope;
    expect(reranking.status).toBe("degraded");
    expect(reranking.reason).toBe("rate_limited");
    expect(reranking.metadata).toMatchObject({ attempts: 2, retries: 1 });
    // Full-jitter backoff drew floor(0.5 * 1000) ms and stayed in budget.
    expect(h.sleeps).toEqual([500]);
    expect(warnings[0]).toMatchObject({
      stage: "reranking",
      code: "rate_limited",
      retryable: true,
    });
  });
});

describe("cumulative query cost budget", () => {
  it("refuses the reranking attempt when expansion consumed the ceiling", async () => {
    // Expansion reserves US$0.049 per attempt (US$49 per thousand queries),
    // leaving US$0.001 — less than the reviewed US$0.002 rerank attempt.
    const pricing: ProviderPricingSource = {
      rateFor: (provider: string, model: string) => ({
        provider,
        model,
        endpoint: "https://example.test",
        currency: "USD" as const,
        usdPerMillionInputTokens: null,
        usdPerMillionOutputTokens: null,
        usdPerThousandSearchQueries: provider === "openai" ? 49 : 2,
        reviewedOnIsoDate: "2026-01-01",
      }),
    };
    const h = harness((stage) =>
      stage === "expansion"
        ? { status: 200, body: expandOk({ prompt_tokens: 12, completion_tokens: 7 }) }
        : { status: 200, body: rerankOk(POOL.length) }
    );
    const outcome = await runQuery(baseRequest(), deps(h, { pricing }));
    const { expansion, reranking } = outcome.envelope.pipeline;
    expect(expansion.status).toBe("expanded");
    expect(expansion.metadata).toEqual({
      attempts: 1,
      retries: 0,
      costUsd: 0.049,
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(reranking.status).toBe("degraded");
    expect(reranking.reason).toBe("cost_budget_exceeded");
    expect(reranking.metadata).toEqual({ attempts: 0, retries: 0, costUsd: 0 });
    expect(h.transport.calls.filter((c) => c.stage === "reranking")).toHaveLength(0);
    // Still a usable QMD baseline.
    expect(outcome.envelope.results).toHaveLength(3);
  });
});

describe("independent degradation and mandatory metadata", () => {
  it("degrades both stages independently around a usable QMD baseline", async () => {
    const h = harness(
      (stage) =>
        stage === "expansion" ? { status: 503 } : { status: 429 },
      () => 0,
    );
    const outcome = await runQuery(baseRequest({ explain: true }), deps(h));
    const { pipeline, results, warnings } = outcome.envelope;
    expect(pipeline.status).toBe("degraded");
    expect(pipeline.expansion.status).toBe("degraded");
    expect(pipeline.expansion.reason).toBe("provider_unavailable");
    expect(pipeline.retrieval.status).toBe("ok");
    expect(pipeline.reranking.status).toBe("degraded");
    expect(pipeline.reranking.reason).toBe("rate_limited");
    // Each stage retried once and reported its conservative reserved cost.
    expect(pipeline.expansion.metadata).toMatchObject({ attempts: 2, retries: 1 });
    expect(pipeline.expansion.metadata.costUsd).toBeGreaterThan(0);
    expect(pipeline.reranking.metadata).toMatchObject({ attempts: 2, retries: 1 });
    expect(pipeline.reranking.metadata.costUsd).toBeGreaterThan(0);
    // Mandatory warnings for both degraded stages.
    expect(warnings.map((w) => [w.stage, w.code])).toEqual([
      ["expansion", "provider_unavailable"],
      ["reranking", "rate_limited"],
    ]);
    // Active score semantics: degraded mode exposes QMD position scores with
    // the degraded explanation shape.
    expect(results.map((r) => r.score)).toEqual([1, 0.5, 0.333333]);
    expect(results[0]!.explanation).toEqual({
      qmdRrfRank: 1,
      qmdPositionWeight: 1,
      remoteRerankScore: null,
      finalScore: 1,
    });
  });

  it("reports full metadata, timings, and candidate counts on success", async () => {
    const h = harness((stage) =>
      stage === "expansion"
        ? { status: 200, body: expandOk({ prompt_tokens: 10, completion_tokens: 5 }), advanceMs: 120 }
        : { status: 200, body: rerankOk(POOL.length), advanceMs: 60 }
    );
    const outcome = await runQuery(baseRequest({ explain: true }), deps(h));
    const { pipeline, timingMs, warnings } = outcome.envelope;
    expect(pipeline.status).toBe("ok");
    expect(pipeline.expansion.status).toBe("expanded");
    expect(pipeline.expansion.generatedQueries).toHaveLength(1);
    expect(pipeline.expansion.metadata).toEqual({
      attempts: 1,
      retries: 0,
      costUsd: expect.any(Number),
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(pipeline.reranking.status).toBe("ok");
    expect(pipeline.reranking.metadata).toMatchObject({ attempts: 1, retries: 0 });
    expect(pipeline.retrieval.candidateCount).toBe(3);
    expect(pipeline.reranking.candidateCount).toBe(3);
    expect(timingMs.expansion).toBeGreaterThanOrEqual(120);
    expect(timingMs.reranking).toBeGreaterThanOrEqual(60);
    expect(timingMs.overhead).toBeGreaterThanOrEqual(0);
    expect(warnings).toEqual([]);
    // Blended scoring is active after successful reranking.
    expect(outcome.envelope.results[0]!.explanation!.remoteRerankScore).toBe(0.9);
  });
});
