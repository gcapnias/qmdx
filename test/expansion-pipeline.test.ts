import { describe, expect, it } from "vitest";
import type { HybridQueryResult } from "@tobilu/qmd";
import {
  submissionRoutes,
  runQuery,
  type QueryRequest,
} from "../src/pipeline/search.js";
import type { GeneratedQueryDocument } from "../src/core/envelope.js";
import type { EffectiveProfile, EffectiveRoute } from "../src/config/resolve.js";
import type { ExpandTransport } from "../src/expand/openai.js";

const EXPANSION_ROUTE: EffectiveRoute = {
  stage: "expansion",
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-4o-mini",
  credentialEnv: "QMDX_TEST_EXPANSION_KEY",
};

const ENV = { QMDX_TEST_EXPANSION_KEY: "pipeline-secret-key" };

const PROFILE: EffectiveProfile = {
  name: "test",
  expansion: EXPANSION_ROUTE,
  reranking: {
    stage: "reranking",
    provider: "cohere",
    endpoint: "https://api.cohere.example",
    model: "rerank-v4.0-pro",
    credentialEnv: "QMDX_TEST_RERANKING_KEY",
  },
};

function generated(overrides: Partial<GeneratedQueryDocument> = {}): GeneratedQueryDocument {
  return {
    type: "lex",
    query: "generated variant",
    language: "en",
    purpose: "terminology",
    ...overrides,
  };
}

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
    noRerank: true,
    ...overrides,
  };
}

interface RecordedCall {
  bodyText: string;
}

function expandTransport(
  handler: (call: RecordedCall, attempt: number) => { status: number; body?: unknown },
): ExpandTransport & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport = (async (_url, init) => {
    const call: RecordedCall = { bodyText: init.body };
    calls.push(call);
    const response = handler(call, calls.length);
    return {
      status: response.status,
      headers: {},
      json: async () => response.body,
    };
  }) as ExpandTransport & { calls: RecordedCall[] };
  return Object.assign(transport, { calls });
}

describe("canonical retrieval-route submission order", () => {
  it("submits original lex, generated lex, original vec, then generated vec and hyde", () => {
    const routes = submissionRoutes(baseRequest(), [
      generated({ type: "hyde", purpose: "hypothetical", query: "passage" }),
      generated({ query: "terminology variant" }),
      generated({
        type: "vec",
        purpose: "semantic",
        query: "semantic rewrite",
      }),
      generated({
        query: "translation variant",
        language: "el",
        purpose: "translation",
      }),
    ]);
    expect(routes).toEqual([
      { type: "lex", query: "find things" },
      { type: "lex", query: "terminology variant" },
      { type: "lex", query: "translation variant" },
      { type: "vec", query: "find things" },
      { type: "vec", query: "semantic rewrite" },
      { type: "hyde", query: "passage" },
    ]);
  });

  it("keeps original lexical and vector routes when expansion degrades", () => {
    const routes = submissionRoutes(baseRequest(), []);
    expect(routes).toEqual([
      { type: "lex", query: "find things" },
      { type: "vec", query: "find things" },
    ]);
  });

  it("continues with the original lexical and vector routes when expansion is disabled or unconfigured", () => {
    expect(submissionRoutes(baseRequest(), [])).toEqual([
      { type: "lex", query: "find things" },
      { type: "vec", query: "find things" },
    ]);
  });

  it("retains typed-document explicit routes first with generated queries appended", () => {
    const request = baseRequest({
      originalQuery: "typed doc",
      plainQuery: "typed doc plain",
      routes: [
        { type: "vec", query: "explicit vector route" },
      ],
    });
    const routes = submissionRoutes(request, [
      generated({ query: "appended" }),
    ]);
    expect(routes).toEqual([
      { type: "vec", query: "explicit vector route" },
      { type: "lex", query: "appended" },
    ]);
  });
});

describe("runQuery expansion integration", () => {
  it("reports expanded status with validated generated queries", async () => {
    const transport = expandTransport(() => ({
      status: 200,
      body: {
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              outcome: "expanded",
              queries: [{
                type: "lex",
                query: "expanded terminology",
                language: "en",
                purpose: "terminology",
              }],
            }),
          },
        }],
      },
    }));
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => [poolEntry(1), poolEntry(2)],
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    expect(outcome.envelope.pipeline.expansion.status).toBe("expanded");
    expect(outcome.envelope.pipeline.expansion.reason).toBeNull();
    expect(outcome.envelope.pipeline.expansion.generatedQueries).toEqual([{
      type: "lex",
      query: "expanded terminology",
      language: "en",
      purpose: "terminology",
    }]);
    expect(outcome.envelope.pipeline.status).toBe("ok");
    expect(outcome.envelope.warnings).toEqual([]);
    // Only the original plain query was transmitted.
    expect(transport.calls).toHaveLength(1);
    const sent = JSON.parse(transport.calls[0]!.bodyText) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.messages[1]).toEqual({
      role: "user",
      content: "find things",
    });
  });

  it("degrades visibly on runtime failure while keeping usable results", async () => {
    const transport = expandTransport(() => ({ status: 503, body: {} }));
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => [poolEntry(1)],
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
      rng: () => 0,
      sleep: async () => {},
    });
    const { pipeline, warnings } = outcome.envelope;
    expect(pipeline.status).toBe("degraded");
    expect(pipeline.expansion.status).toBe("degraded");
    expect(pipeline.expansion.reason).toBe("provider_unavailable");
    expect(pipeline.expansion.generatedQueries).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      stage: "expansion",
      code: "provider_unavailable",
      retryable: true,
    });
    expect(pipeline.retrieval.status).toBe("ok");
    expect(outcome.envelope.results).toHaveLength(1);
  });

  it("deterministically disables the stage under --no-expand", async () => {
    const transport = expandTransport(() => ({ status: 200, body: {} }));
    const outcome = await runQuery(
      baseRequest({ noExpand: true }),
      {
        fetchPool: async () => [poolEntry(1)],
        effectiveProfile: PROFILE,
        env: ENV,
        transport,
      },
    );
    expect(outcome.envelope.pipeline.expansion.status).toBe("disabled");
    expect(outcome.envelope.pipeline.expansion.reason).toBeNull();
    expect(outcome.envelope.warnings).toEqual([]);
    expect(transport.calls).toHaveLength(0);
    expect(submissionRoutes(baseRequest({ noExpand: true }), [])).toEqual([
      { type: "lex", query: "find things" },
      { type: "vec", query: "find things" },
    ]);
  });

  it("disables the stage for typed documents without a plain query", async () => {
    const transport = expandTransport(() => ({ status: 200, body: {} }));
    const outcome = await runQuery(
      baseRequest({ plainQuery: null }),
      {
        fetchPool: async () => [poolEntry(1)],
        effectiveProfile: PROFILE,
        env: ENV,
        transport,
      },
    );
    expect(outcome.envelope.pipeline.expansion.status).toBe("disabled");
    expect(transport.calls).toHaveLength(0);
  });

  it("keeps the stable unconfigured-route degradation without a profile", async () => {
    const transport = expandTransport(() => ({ status: 200, body: {} }));
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => [poolEntry(1)],
      effectiveProfile: null,
      env: ENV,
      transport,
    });
    expect(outcome.envelope.pipeline.expansion.status).toBe("degraded");
    expect(outcome.envelope.pipeline.expansion.reason).toBe("provider_unavailable");
    expect(outcome.envelope.warnings[0]).toMatchObject({
      stage: "expansion",
      code: "provider_unavailable",
      retryable: false,
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("reports original_sufficient without generated queries and without degradation", async () => {
    const transport = expandTransport(() => ({
      status: 200,
      body: {
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              outcome: "original_sufficient",
              queries: [],
            }),
          },
        }],
      },
    }));
    const outcome = await runQuery(baseRequest(), {
      fetchPool: async () => [poolEntry(1)],
      effectiveProfile: PROFILE,
      env: ENV,
      transport,
    });
    expect(outcome.envelope.pipeline.status).toBe("ok");
    expect(outcome.envelope.pipeline.expansion.status).toBe("original_sufficient");
    expect(outcome.envelope.warnings).toEqual([]);
  });
});
