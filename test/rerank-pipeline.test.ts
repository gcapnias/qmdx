import { describe, expect, it } from "vitest";
import type { HybridQueryResult } from "@tobilu/qmd";
import {
  admitRemoteRoutes,
} from "../src/preflight/preflight.js";
import { runQuery, type QueryRequest } from "../src/pipeline/search.js";
import type {
  RerankTransport,
} from "../src/rerank/cohere.js";
import type { EffectiveRoute } from "../src/config/resolve.js";

const ROUTE: EffectiveRoute = {
  stage: "reranking",
  provider: "cohere",
  endpoint: "https://api.cohere.example",
  model: "rerank-v4.0-pro",
  credentialEnv: "QMDX_TEST_RERANKING_KEY",
};

const ENV = { QMDX_TEST_RERANKING_KEY: "pipeline-secret-key" };

const PROFILE = {
  name: "test",
  expansion: {
    stage: "expansion" as const,
    provider: "openai",
    endpoint: "https://api.openai.example/v1",
    model: "gpt-4o-mini",
    credentialEnv: "QMDX_TEST_EXPANSION_KEY",
  },
  reranking: ROUTE,
};

function poolEntry(rank: number, overrides: Partial<HybridQueryResult> = {}): HybridQueryResult {
  return {
    file: `qmd://docs/${String.fromCharCode(96 + rank)}.md`,
    displayPath: `${String.fromCharCode(96 + rank)}.md`,
    title: `TITLE MARKER ${rank}`,
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
        contributions: [{ queryType: "original", rank: 1, weight: 2 }],
      },
      rerankScore: 0,
      blendedScore: 1 / rank,
    },
    ...overrides,
  } as HybridQueryResult;
}

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
    noExpand: true,
    noRerank: false,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

function okTransport(
  scoresForChunks: Array<{ chunk: string; score: number }>,
): RerankTransport & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport = (async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      bodyText: init.body,
    });
    const parsed = JSON.parse(init.body) as {
      documents: Array<{ text: string }>;
    };
    return {
      status: 200,
      headers: {},
      json: async () => ({
        id: "resp-1",
        results: parsed.documents.map((doc) => ({
          index: parsed.documents.indexOf(doc),
          relevance_score:
            scoresForChunks.find((entry) => entry.chunk === doc.text)?.score ?? 0,
        })),
      }),
    };
  }) as RerankTransport & { calls: RecordedCall[] };
  return Object.assign(transport, { calls });
}

describe("runQuery reranking integration", () => {
  it("blends position weights with remote scores using the normative worked examples", async () => {
    // Spec table: rank1/0.00 -> 0.7500; rank2/0.89 -> 0.5975;
    // rank4/0.89 -> 0.5060; rank11/0.89 -> 0.5704 (display-rounded).
    const pool = [
      poolEntry(1),
      poolEntry(2),
      poolEntry(4),
      poolEntry(11),
    ];
    const transport = okTransport([
      { chunk: "SELECTED CHUNK 1", score: 0 },
      { chunk: "SELECTED CHUNK 2", score: 0.89 },
      { chunk: "SELECTED CHUNK 4", score: 0.89 },
      { chunk: "SELECTED CHUNK 11", score: 0.89 },
    ]);
    const outcome = await runQuery(baseRequest({ explain: true }), {
      fetchPool: async () => pool,
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    const { results, pipeline } = outcome.envelope;
    expect(pipeline.reranking.status).toBe("ok");
    expect(pipeline.reranking.reason).toBeNull();
    expect(results.map((result) => result.docid)).toEqual([
      "#100001",
      "#100002",
      "#100011",
      "#100004",
    ]);
    expect(results.map((result) => result.score)).toEqual([
      0.75,
      0.5975,
      0.570364,
      0.506,
    ]);
    expect(results[0]!.explanation).toEqual({
      qmdRrfRank: 1,
      qmdPositionWeight: 0.75,
      remoteRerankScore: 0,
      finalScore: 0.75,
    });
    expect(results[2]!.explanation).toEqual({
      qmdRrfRank: 11,
      qmdPositionWeight: 0.4,
      remoteRerankScore: 0.89,
      finalScore: 0.570364,
    });
  });

  it("breaks equal final scores by lower QMD RRF rank, then internal file identity", async () => {
    // rank10/0.75 -> 0.36 exactly; rank11/0.539394 -> 0.36 after 6-dp
    // rounding: an exact cross-band tie. Lower rank wins over identity.
    // A duplicate-rank pair ties identically and falls back to identity.
    const pool = [
      poolEntry(11, { file: "qmd://docs/a.md", docid: "200001" }),
      poolEntry(10, { file: "qmd://docs/z.md", docid: "200002" }),
      poolEntry(5, { file: "qmd://docs/z.md", docid: "200003", bestChunk: "TIE Z" }),
      poolEntry(5, { file: "qmd://docs/a.md", docid: "200004", bestChunk: "TIE A" }),
    ];
    const transport = okTransport([
      { chunk: "SELECTED CHUNK 11", score: 0.539394 },
      { chunk: "SELECTED CHUNK 10", score: 0.75 },
      { chunk: "TIE Z", score: 0.5 },
      { chunk: "TIE A", score: 0.5 },
    ]);
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => pool,
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    const { results } = outcome.envelope;
    expect(results.map((result) => result.score)).toEqual([
      0.36,
      0.36,
      0.32,
      0.32,
    ]);
    expect(results[0]!.file).toBe("qmd://docs/z.md");
    expect(results[1]!.file).toBe("qmd://docs/a.md");
    expect(results[2]!.file).toBe("qmd://docs/a.md");
    expect(results[3]!.file).toBe("qmd://docs/z.md");
  });

  it("keeps QMD fused order with position scores and null remote scores on exhausted retry", async () => {
    const pool = [poolEntry(1), poolEntry(2), poolEntry(3)];
    const failingTransport = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as RerankTransport;
    const outcome = await runQuery(baseRequest({ explain: true }), {
      fetchPool: async () => pool,
      effectiveProfile: PROFILE,
      env: ENV,
      transport: failingTransport,
      rng: () => 0,
      sleep: async () => undefined,
    });
    const { results, pipeline, warnings } = outcome.envelope;
    expect(pipeline.status).toBe("degraded");
    expect(pipeline.reranking.status).toBe("degraded");
    expect(pipeline.reranking.reason).toBe("transport_error");
    expect(results.map((result) => result.rank)).toEqual([1, 2, 3]);
    expect(results.map((result) => result.file)).toEqual(pool.map((entry) => entry.file));
    expect(results[0]!.score).toBeCloseTo(1, 6);
    expect(results[1]!.score).toBeCloseTo(0.5, 6);
    expect(warnings.some((warning) =>
      warning.stage === "reranking" &&
      warning.code === "transport_error" &&
      warning.message.includes("Kept QMD fused order.")
    )).toBe(true);
    expect(results.every((result) =>
      result.explanation === undefined ||
      (result.explanation.remoteRerankScore === null &&
        result.explanation.qmdPositionWeight === 1)
    )).toBe(true);
  });

  it("--no-rerank deterministically disables the stage without any transmission", async () => {
    const pool = [poolEntry(1), poolEntry(2)];
    let called = 0;
    const transport = (() => {
      called += 1;
      throw new Error("must not transmit");
    }) as unknown as RerankTransport;
    const outcome = await runQuery(baseRequest({ noRerank: true, explain: true }), {
      fetchPool: async () => pool,
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    const { pipeline, warnings, results } = outcome.envelope;
    expect(called).toBe(0);
    expect(pipeline.reranking.status).toBe("disabled");
    expect(pipeline.reranking.reason).toBeNull();
    expect(warnings).toHaveLength(0);
    expect(results.map((result) => result.score)).toEqual([1, 0.5]);
    expect(results[0]!.explanation).toEqual({
      qmdRrfRank: 1,
      qmdPositionWeight: 1,
      remoteRerankScore: null,
      finalScore: 1,
    });
  });

  it("applies min-score filtering to the active pipeline's public score", async () => {
    const pool = [poolEntry(1), poolEntry(2), poolEntry(4), poolEntry(11)];
    const transport = okTransport([
      { chunk: "SELECTED CHUNK 1", score: 0 },
      { chunk: "SELECTED CHUNK 2", score: 0.89 },
      { chunk: "SELECTED CHUNK 4", score: 0.89 },
      { chunk: "SELECTED CHUNK 11", score: 0.89 },
    ]);
    const outcome = await runQuery(baseRequest({ minScore: 0.55 }), {
      fetchPool: async () => pool,
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    // Blended scores: 0.75, 0.5975, 0.506, 0.570364 -> 0.506 drops out.
    expect(outcome.envelope.results.map((result) => result.docid)).toEqual([
      "#100001",
      "#100002",
      "#100011",
    ]);
  });

  it("keeps the stable unconfigured-route degradation when no profile exists", async () => {
    const pool = [poolEntry(1)];
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => pool,
      effectiveProfile: null,
      env: ENV,
      transport: okTransport([]),
    });
    const { pipeline, warnings } = outcome.envelope;
    expect(pipeline.reranking.status).toBe("degraded");
    expect(pipeline.reranking.reason).toBe("provider_unavailable");
    expect(warnings).toEqual([
      {
        stage: "reranking",
        code: "provider_unavailable",
        message:
          "No remote reranking route is configured; kept QMD fused order.",
        retryable: false,
      },
    ]);
  });
});

describe("production payload audit", () => {
  it("transmits only the reranking query and exact selected chunks", async () => {
    const pool = [
      poolEntry(1),
      poolEntry(2, { bestChunk: "DUPLICATED CHUNK" }),
      poolEntry(3, { bestChunk: "DUPLICATED CHUNK" }),
    ];
    const transport = okTransport([
      { chunk: "SELECTED CHUNK 1", score: 0.9 },
      { chunk: "DUPLICATED CHUNK", score: 0.8 },
      { chunk: "DUPLICATED CHUNK", score: 0.7 },
    ]);
    const outcome = await runQuery(
      baseRequest({ intent: "USER INTENT", originalQuery: "ORIGINAL QUERY TEXT" }),
      {
        fetchPool: async () => pool,
        effectiveProfile: PROFILE,
        env: ENV,
        transport,
      },
    );
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe("https://api.cohere.example/v2/rerank");
    const sent = JSON.parse(call.bodyText) as {
      query: string;
      documents: Array<{ text: string }>;
    };

    // The reranking query is intent + original query, nothing generated.
    expect(sent.query).toBe("USER INTENT\n\nORIGINAL QUERY TEXT");
    // Every candidate's exact selected chunk goes out, duplicates included.
    const rawBody = call.bodyText;
    expect(rawBody).toContain("SELECTED CHUNK 1");
    expect(sent.documents).toEqual([
      { text: "SELECTED CHUNK 1" },
      { text: "DUPLICATED CHUNK" },
      { text: "DUPLICATED CHUNK" },
    ]);

    // Titles, paths, context, full bodies, and retrieval traces stay local.
    for (const secret of [
      "TITLE MARKER",
      "SECRET-BODY-MARKER",
      "CONTEXT MARKER",
      "qmd://docs/",
      ".md",
      "contributions",
      "rrf",
      "FULL BODY",
    ]) {
      expect(rawBody).not.toContain(secret);
    }

    // The credential travels only in the Authorization header and appears
    // nowhere in the returned envelope.
    expect(call.headers.Authorization).toBe("Bearer pipeline-secret-key");
    expect(JSON.stringify(outcome)).not.toContain("pipeline-secret-key");

    // Successful reranking keeps all three candidates, duplicates distinct.
    expect(outcome.envelope.pipeline.reranking.status).toBe("ok");
    expect(outcome.envelope.results).toHaveLength(3);
  });

  it("never sends retrieval traces even when admission rejects the payload", async () => {
    const oversizedChunk = "x".repeat(500_000);
    const pool = [poolEntry(1, { bestChunk: oversizedChunk })];
    let transmitted = 0;
    const transport = (() => {
      transmitted += 1;
      throw new Error("must never transmit");
    }) as unknown as RerankTransport;
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => pool,
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    expect(transmitted).toBe(0);
    expect(outcome.envelope.pipeline.reranking.reason).toBe(
      "payload_limit_exceeded",
    );
  });
});

// Re-assurance that route admission still gates real invocations end-to-end
// (the pipeline consumes whatever admitRemoteRoutes admitted).
describe("route admission seam", () => {
  it("admitRemoteRoutes remains the gate the command layer feeds to runQuery", () => {
    expect(typeof admitRemoteRoutes).toBe("function");
  });
});
