import { describe, expect, it } from "vitest";
import type { HybridQueryResult } from "@tobilu/qmd";
import { manualClock } from "../src/core/clock.js";
import { DEFAULT_RERANKING_STAGE_BUDGET_MS } from "../src/core/budgets.js";
import {
  CONSERVATIVE_CHARS_PER_TOKEN,
  MAX_RERANK_DOCUMENTS,
  PER_DOC_TOKEN_OVERHEAD,
  VALIDATED_MAX_TOKENS_PER_DOC,
  admitRerankRequest,
  conservativeTokenUpperBound,
  estimateWorstCaseAttemptCostUsd,
  PayloadLimitExceededError,
} from "../src/rerank/admission.js";
import {
  buildCohereRequest,
  classifyFailure,
  validateCohereResponse,
  InvalidProviderResponseError,
  type RerankTransport,
} from "../src/rerank/cohere.js";
import {
  assembleCandidates,
  buildRerankingQuery,
  runRerankingStage,
} from "../src/rerank/stage.js";
import type { EffectiveRoute } from "../src/config/resolve.js";
import type { RateCardEntry } from "../src/core/pricing.js";

const ROUTE: EffectiveRoute = {
  stage: "reranking",
  provider: "cohere",
  endpoint: "https://api.cohere.com",
  model: "rerank-v4.0-pro",
  credentialEnv: "QMDX_TEST_RERANKING_KEY",
};

const ENV = { QMDX_TEST_RERANKING_KEY: "test-secret-key" };function rateCard(overrides: Partial<RateCardEntry> = {}): RateCardEntry {
  return {
    provider: "cohere",
    model: "rerank-v4.0-pro",
    endpoint: "https://api.cohere.com",
    currency: "USD",
    usdPerMillionInputTokens: null,
    usdPerMillionOutputTokens: null,
    usdPerThousandSearchQueries: 2.0,
    reviewedOnIsoDate: "2026-08-24",
    ...overrides,
  };
}

interface TransportCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string; timeoutMs?: number };
}

function stubTransport(
  handler: (call: TransportCall, attempt: number) =>
    | { status: number; headers?: Record<string, string>; body?: unknown }
    | Promise<never>,
): RerankTransport & { calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  const transport = (async (url, init) => {
    const call: TransportCall = { url, init };
    calls.push(call);
    const response = await handler(call, calls.length);
    return {
      status: response.status,
      headers: response.headers ?? {},
      json: async () => response.body,
    };
  }) as RerankTransport & { calls: TransportCall[] };
  return Object.assign(transport, { calls });
}

function okBody(scores: number[]): unknown {
  return {
    id: "resp-1",
    results: scores.map((relevance_score, index) => ({
      index,
      relevance_score,
    })),
  };
}

export function poolEntry(
  overrides: Partial<HybridQueryResult> & { rank: number },
): HybridQueryResult {
  const { rank, ...rest } = overrides;
  return {
    file: `qmd://docs/doc-${rank}.md`,
    displayPath: `doc-${rank}.md`,
    title: `Title ${rank}`,
    body: `FULL BODY ${rank} SECRET-BODY-MARKER`,
    bestChunk: `SELECTED CHUNK ${rank}`,
    bestChunkPos: rank,
    context: `CONTEXT MARKER ${rank}`,
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
    ...rest,
  } as HybridQueryResult;
}

describe("reranking query construction", () => {
  it("appends intent to the original query separated by a blank line", () => {
    expect(buildRerankingQuery("vector stores", "compare sqlite backends")).toBe(
      "compare sqlite backends\n\nvector stores",
    );
  });

  it("uses the unchanged original query without intent", () => {
    expect(buildRerankingQuery("vector stores", null)).toBe("vector stores");
    expect(buildRerankingQuery("vector stores", "")).toBe("vector stores");
    expect(buildRerankingQuery("vector stores", "   ")).toBe("vector stores");
  });
});

describe("candidate assembly", () => {
  it("keeps every candidate distinct, including identical chunks", () => {
    const pool = [
      poolEntry({ rank: 1 }),
      poolEntry({ rank: 2, bestChunk: "SAME TEXT" }),
      poolEntry({ rank: 3, bestChunk: "SAME TEXT" }),
    ];
    const assembled = assembleCandidates(pool);
    expect(assembled.documents).toHaveLength(3);
    expect(assembled.documents[0]!.chunk).toBe("SELECTED CHUNK 1");
    expect(assembled.documents[1]!.chunk).toBe("SAME TEXT");
    expect(assembled.documents[2]!.chunk).toBe("SAME TEXT");
    expect(new Set(assembled.documents.map((doc) => doc.identity)).size).toBe(3);
  });

  it("excludes entries whose selected chunk is empty", () => {
    const pool = [
      poolEntry({ rank: 1 }),
      poolEntry({ rank: 2, bestChunk: "" }),
      poolEntry({ rank: 3, bestChunk: "   \n\t" }),
    ];
    const assembled = assembleCandidates(pool);
    expect(assembled.documents.map((doc) => doc.poolIndex)).toEqual([0]);
  });
});

describe("conservative token accounting and route admission", () => {
  it("bounds tokens conservatively above any plausible tokenizer count", () => {
    const text = "x".repeat(90);
    const bound = conservativeTokenUpperBound(text);
    expect(bound).toBe(
      Math.ceil(90 / CONSERVATIVE_CHARS_PER_TOKEN) + PER_DOC_TOKEN_OVERHEAD,
    );
    // The bound must never under-count: 3 chars/token over-estimates.
    expect(bound * 3).toBeGreaterThanOrEqual(text.length);
  });

  it("admits a well-formed request and computes max_tokens_per_doc for the largest chunk only", () => {
    const admitted = admitRerankRequest("find things", [
      { identity: "a", poolIndex: 0, chunk: "y".repeat(100) },
      { identity: "b", poolIndex: 1, chunk: "z".repeat(200) },
    ]);
    expect(admitted.documents.map((doc) => doc.index)).toEqual([0, 1]);
    const smallBound = Math.ceil(100 / 3) + PER_DOC_TOKEN_OVERHEAD;
    const largeBound = Math.ceil(200 / 3) + PER_DOC_TOKEN_OVERHEAD;
    expect(admitted.maxTokensPerDoc).toBe(largeBound);
    expect(admitted.maxTokensPerDoc).toBeLessThanOrEqual(
      VALIDATED_MAX_TOKENS_PER_DOC,
    );
    expect(admitted.totalInputTokensUpperBound).toBe(
      Math.ceil("find things".length / 3) + PER_DOC_TOKEN_OVERHEAD +
        smallBound + largeBound,
    );
  });

  it("rejects an empty document set", () => {
    expect(() => admitRerankRequest("q", [])).toThrow(PayloadLimitExceededError);
  });

  it("rejects more than the spec cap of documents", () => {
    const docs = Array.from({ length: MAX_RERANK_DOCUMENTS + 1 }, (_, i) => ({
      identity: `doc-${i}`,
      poolIndex: i,
      chunk: `chunk ${i}`,
    }));
    expect(() => admitRerankRequest("q", docs)).toThrow(
      PayloadLimitExceededError,
    );
  });

  it("rejects when one chunk cannot be proven to fit without truncation", () => {
    const oversized = "x".repeat((VALIDATED_MAX_TOKENS_PER_DOC - PER_DOC_TOKEN_OVERHEAD) *
      CONSERVATIVE_CHARS_PER_TOKEN + 1);
    expect(() =>
      admitRerankRequest("q", [{ identity: "big", poolIndex: 0, chunk: oversized }]),
    ).toThrow(PayloadLimitExceededError);
  });

  it("rejects an empty chunk at admission time", () => {
    expect(() =>
      admitRerankRequest("q", [{ identity: "e", poolIndex: 0, chunk: "  " }]),
    ).toThrow(PayloadLimitExceededError);
  });

  it("rejects when the aggregate request cannot be proven to fit", () => {
    // Each chunk bounds at ceil(4830/3)+8 = 1618 tokens; 80 of them exceed
    // the validated aggregate maximum even though each fits individually.
    const docs = Array.from({ length: MAX_RERANK_DOCUMENTS }, (_, i) => ({
      identity: `doc-${i}`,
      poolIndex: i,
      chunk: "w".repeat(4830),
    }));
    expect(() => admitRerankRequest("q", docs)).toThrow(
      PayloadLimitExceededError,
    );
  });

  it("estimates worst-case cost from the per-search-query rate card entry", () => {
    const admitted = admitRerankRequest("q", [
      { identity: "a", poolIndex: 0, chunk: "chunk text" },
    ]);
    expect(estimateWorstCaseAttemptCostUsd(admitted, rateCard())).toBeCloseTo(
      0.002,
      10,
    );
    expect(
      estimateWorstCaseAttemptCostUsd(
        admitted,
        rateCard({ usdPerThousandSearchQueries: null, usdPerMillionInputTokens: 1 }),
      ),
    ).toBeGreaterThan(0);
  });
});

describe("Cohere request building", () => {
  it("builds the v2 rerank payload with opaque indexes and exact chunks", () => {
    const admitted = admitRerankRequest("intent\n\nquery", [
      { identity: "id-a", poolIndex: 4, chunk: "CHUNK A" },
      { identity: "id-b", poolIndex: 9, chunk: "CHUNK B" },
    ]);
    const built = buildCohereRequest(ROUTE, "secret-key", admitted);
    expect(built.url).toBe("https://api.cohere.com/v2/rerank");
    expect(built.init.headers.Authorization).toBe("Bearer secret-key");
    const parsed = JSON.parse(built.serializedBody);
    expect(parsed.model).toBe("rerank-v4.0-pro");
    expect(parsed.query).toBe("intent\n\nquery");
    expect(parsed.top_n).toBe(2);
    expect(parsed.documents).toEqual([
      { text: "CHUNK A" },
      { text: "CHUNK B" },
    ]);
    expect(parsed.max_tokens_per_doc).toBeGreaterThan(0);
    // Identities stay local; they are never transmitted.
    expect(built.serializedBody).not.toContain("id-a");
    expect(built.serializedBody).not.toContain("id-b");
  });
});

describe("provider response validation", () => {
  it("accepts every candidate exactly once with finite [0,1] scores", () => {
    expect(validateCohereResponse(okBody([0, 0.5, 1]), 3)).toEqual([0, 0.5, 1]);
  });

  it("accepts results in any order and maps them by index", () => {
    const body = {
      results: [
        { index: 2, relevance_score: 0.3 },
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.6 },
      ],
    };
    expect(validateCohereResponse(body, 3)).toEqual([0.9, 0.6, 0.3]);
  });

  const invalidBodies: Array<{ label: string; body: unknown; count: number }> = [
    { label: "missing results array", body: {}, count: 2 },
    { label: "non-object body", body: null, count: 2 },
    { label: "wrong result count", body: okBody([0.5, 0.5]), count: 3 },
    { label: "missing candidate", body: okBody([0.5]), count: 2 },
    {
      label: "duplicate candidate",
      body: {
        results: [
          { index: 0, relevance_score: 0.5 },
          { index: 0, relevance_score: 0.6 },
        ],
      },
      count: 2,
    },
    {
      label: "unknown candidate",
      body: {
        results: [
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.5 },
          { index: 9, relevance_score: 0.5 },
        ],
      },
      count: 2,
    },
    { label: "out-of-range index", body: { results: [{ index: 7, relevance_score: 0.5 }] }, count: 2 },
    { label: "non-integer index", body: { results: [{ index: 0.5, relevance_score: 0.5 }] }, count: 2 },
    { label: "score above 1", body: { results: [{ index: 0, relevance_score: 1.01 }] }, count: 1 },
    { label: "score below 0", body: { results: [{ index: 0, relevance_score: -0.1 }] }, count: 1 },
    { label: "NaN score", body: { results: [{ index: 0, relevance_score: Number.NaN }] }, count: 1 },
    { label: "string score", body: { results: [{ index: 0, relevance_score: "0.5" }] }, count: 1 },
  ];

  for (const testCase of invalidBodies) {
    it(`invalidates the whole response: ${testCase.label}`, () => {
      expect(() =>
        validateCohereResponse(testCase.body, testCase.count),
      ).toThrow(InvalidProviderResponseError);
    });
  }
});

describe("transient failure classification", () => {
  const cases: Array<{
    name: string;
    status: number | null;
    cause?: unknown;
    reason: string;
    retryable: boolean;
  }> = [
    { name: "HTTP 408", status: 408, reason: "timeout", retryable: true },
    { name: "HTTP 429", status: 429, reason: "rate_limited", retryable: true },
    { name: "HTTP 500", status: 500, reason: "provider_unavailable", retryable: true },
    { name: "HTTP 503", status: 503, reason: "provider_unavailable", retryable: true },
    { name: "transport error", status: null, cause: new Error("ECONNRESET"), reason: "transport_error", retryable: true },
    { name: "attempt timeout", status: null, cause: Object.assign(new Error("timed out"), { name: "QmdxAttemptTimeoutError" }), reason: "timeout", retryable: true },
    { name: "invalid response shape", status: null, cause: new InvalidProviderResponseError("bad"), reason: "invalid_provider_response", retryable: true },
    { name: "HTTP 401", status: 401, reason: "authentication_failed", retryable: false },
    { name: "HTTP 403", status: 403, reason: "authentication_failed", retryable: false },
    { name: "HTTP 402", status: 402, reason: "billing_or_quota_exhausted", retryable: false },
    { name: "HTTP 404", status: 404, reason: "unsupported_capability", retryable: false },
    { name: "other 4xx policy refusal", status: 422, reason: "provider_policy_rejected", retryable: false },
  ];

  for (const testCase of cases) {
    it(`classifies ${testCase.name} as ${testCase.reason}`, () => {
      const classification = classifyFailure(testCase.cause, testCase.status);
      expect(classification.reason).toBe(testCase.reason);
      expect(classification.retryable).toBe(testCase.retryable);
    });
  }
});

function conservativeTokenUpperBoundSafe(text: string): number {
  return Math.ceil([...text].length / CONSERVATIVE_CHARS_PER_TOKEN) +
    PER_DOC_TOKEN_OVERHEAD;
}

describe("stage orchestration", () => {
  const pool = [
    poolEntry({ rank: 1 }),
    poolEntry({ rank: 2 }),
    poolEntry({ rank: 11 }),
  ];

  function successDeps(scores: number[]) {
    const transport = stubTransport(() => ({ status: 200, body: okBody(scores) }));
    return { transport };
  }


  it("returns remote scores keyed by pool entry on a valid response", async () => {
    const { transport } = successDeps([0.9, 0.4, 0.7]);
    const outcome = await runRerankingStage(
      { pool, originalQuery: "find it", intent: null },
      ROUTE,
      { transport, env: ENV },
    );
    expect(outcome.report).toEqual({ status: "ok", reason: null });
    expect(outcome.warning).toBeNull();
    expect(outcome.remoteRerankScores?.get(pool[0]!)).toBe(0.9);
    expect(outcome.remoteRerankScores?.get(pool[1]!)).toBe(0.4);
    expect(outcome.remoteRerankScores?.get(pool[2]!)).toBe(0.7);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.url).toBe("https://api.cohere.com/v2/rerank");
  });

  it("sends the intent-composed query and never generated routes", async () => {
    const { transport } = successDeps([0.9, 0.4, 0.7]);
    await runRerankingStage(
      { pool, originalQuery: "original query text", intent: "user intent" },
      ROUTE,
      { transport, env: ENV },
    );
    const body = JSON.parse(transport.calls[0]!.init.body);
    expect(body.query).toBe("user intent\n\noriginal query text");
    expect(body.query).not.toContain("generated");
  });

  it("keeps credentials off the wire except the auth header and out of outcomes", async () => {
    const { transport } = successDeps([0.9, 0.4, 0.7]);
    const outcome = await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      { transport, env: ENV },
    );
    expect(JSON.stringify(outcome)).not.toContain("test-secret-key");
    expect(transport.calls[0]!.init.headers.Authorization).toBe(
      "Bearer test-secret-key",
    );
  });

  it("degrades after exactly one retry on transient failures", async () => {
    let attempts = 0;
    const transport = stubTransport(() => {
      attempts += 1;
      throw new Error("ECONNRESET");
    });
    const outcome = await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      { transport, env: ENV, rng: () => 0, sleep: async () => undefined },
    );
    expect(attempts).toBe(2);
    expect(outcome.report.status).toBe("degraded");
    expect(outcome.remoteRerankScores).toBeNull();
    expect(outcome.warning?.code).toBe("transport_error");
    expect(outcome.warning?.message).toContain("Kept QMD fused order.");
  });

  it("does not retry non-transient authentication failure", async () => {
    let attempts = 0;
    const transport = stubTransport(() => {
      attempts += 1;
      return { status: 401, body: { message: "invalid key" } };
    });
    const outcome = await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      { transport, env: ENV },
    );
    expect(attempts).toBe(1);
    expect(outcome.warning?.code).toBe("authentication_failed");
    expect(outcome.warning?.retryable).toBe(false);
  });

  it("recovers when the retried attempt succeeds", async () => {
    const transport = stubTransport((_, attempt) =>
      attempt === 1
        ? { status: 503 }
        : { status: 200, body: okBody([0.8, 0.2, 0.5]) }
    );
    const outcome = await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      { transport, env: ENV, sleep: async () => undefined },
    );
    expect(transport.calls).toHaveLength(2);
    expect(outcome.report.status).toBe("ok");
    expect(outcome.remoteRerankScores?.get(pool[1]!)).toBe(0.2);
  });

  it("honors Retry-After only when it fits the remaining budget", async () => {
    const transport = stubTransport((_, attempt) =>
      attempt === 1 ? { status: 429, headers: { "retry-after": "2" } } : { status: 200, body: okBody([0.8, 0.2, 0.5]) }
    );
    const waits: number[] = [];
    await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      {
        transport,
        env: ENV,
        clock: manualClock(0),
        sleep: async (ms) => void waits.push(ms),
      },
    );
    expect(waits).toEqual([2000]);
  });

  it("fails closed before transmission when cost admission cannot fit", async () => {
    const transport = stubTransport(() => {
      throw new Error("must not transmit");
    });
    const outcome = await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      {
        transport,
        env: ENV,
        pricing: { rateFor: () => rateCard({ usdPerThousandSearchQueries: 10_000 }) },
      },
    );
    expect(transport.calls).toHaveLength(0);
    expect(outcome.report.reason).toBe("cost_budget_exceeded");
    expect(outcome.warning?.retryable).toBe(false);
  });

  it("fails closed before transmission when the stage budget is already spent", async () => {
    const transport = stubTransport(() => {
      throw new Error("must not transmit");
    });
    // A clock that has already burned the whole cumulative stage budget by
    // the time the first admission check runs.
    let ticks = 0;
    const spentClock = { nowMs: () => (ticks += DEFAULT_RERANKING_STAGE_BUDGET_MS + 1) };
    const outcome = await runRerankingStage(
      { pool, originalQuery: "q", intent: null },
      ROUTE,
      { transport, env: ENV, clock: spentClock },
    );
    expect(transport.calls).toHaveLength(0);
    expect(outcome.report.reason).toBe("stage_budget_exceeded");
  });

  it("degrades with payload_limit_exceeded when no no-truncation proof exists", async () => {
    const oversized = "x".repeat(
      (VALIDATED_MAX_TOKENS_PER_DOC - PER_DOC_TOKEN_OVERHEAD) *
        CONSERVATIVE_CHARS_PER_TOKEN + 1,
    );
    const transport = stubTransport(() => {
      throw new Error("must not transmit");
    });
    const outcome = await runRerankingStage(
      {
        pool: [poolEntry({ rank: 1, bestChunk: oversized })],
        originalQuery: "q",
        intent: null,
      },
      ROUTE,
      { transport, env: ENV },
    );
    expect(transport.calls).toHaveLength(0);
    expect(outcome.report.reason).toBe("payload_limit_exceeded");
    expect(outcome.warning?.message).toContain("Kept QMD fused order.");
  });

  it("degrades when the whole pool lacks usable selected chunks", async () => {
    const transport = stubTransport(() => {
      throw new Error("must not transmit");
    });
    const outcome = await runRerankingStage(
      {
        pool: [poolEntry({ rank: 1, bestChunk: "" })],
        originalQuery: "q",
        intent: null,
      },
      ROUTE,
      { transport, env: ENV },
    );
    expect(transport.calls).toHaveLength(0);
    expect(outcome.report.reason).toBe("payload_limit_exceeded");
  });

  it("treats a deduplicating provider response as invalid and degrades", async () => {
    const transport = stubTransport(() => ({
      status: 200,
      body: { results: [{ index: 0, relevance_score: 0.5 }] },
    }));
    const outcome = await runRerankingStage(
      {
        pool: [
          poolEntry({ rank: 1, bestChunk: "SAME" }),
          poolEntry({ rank: 2, bestChunk: "SAME" }),
          poolEntry({ rank: 3, bestChunk: "SAME" }),
        ],
        originalQuery: "q",
        intent: null,
      },
      ROUTE,
      { transport, env: ENV, sleep: async () => undefined },
    );
    expect(transport.calls).toHaveLength(2);
    expect(outcome.report.status).toBe("degraded");
    expect(outcome.report.reason).toBe("invalid_provider_response");
    expect(outcome.warning?.retryable).toBe(true);
  });

  it("reports ok without contacting anyone for an empty pool", async () => {
    const transport = stubTransport(() => {
      throw new Error("must not transmit");
    });
    const outcome = await runRerankingStage(
      { pool: [], originalQuery: "q", intent: null },
      ROUTE,
      { transport, env: ENV },
    );
    expect(outcome.report).toEqual({ status: "ok", reason: null });
    expect(transport.calls).toHaveLength(0);
  });

  it("propagates configuration errors instead of degrading silently", async () => {
    await expect(
      runRerankingStage(
        { pool, originalQuery: "q", intent: null },
        ROUTE,
        { env: {}, transport: stubTransport(() => ({ status: 200 })) },
      ),
    ).rejects.toMatchObject({
      category: "configuration",
      code: "missing_credentials",
    });
  });
});
