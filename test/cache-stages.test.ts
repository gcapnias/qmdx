import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HybridQueryResult } from "@tobilu/qmd";
import { manualClock } from "../src/core/clock.js";
import { createFileResponseStore } from "../src/core/cache.js";
import { runExpansionStage } from "../src/expand/stage.js";
import type { ExpandTransport } from "../src/expand/openai.js";
import { runRerankingStage, assembleCandidates } from "../src/rerank/stage.js";
import type { RerankTransport } from "../src/rerank/cohere.js";
import { runQuery } from "../src/pipeline/search.js";
import type { EffectiveRoute } from "../src/config/resolve.js";
import type { RateCardEntry } from "../src/core/pricing.js";

const EXPANSION_ROUTE: EffectiveRoute = {
  stage: "expansion",
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-4o-mini",
  credentialEnv: "QMDX_TEST_EXPANSION_KEY",
};

const RERANK_ROUTE: EffectiveRoute = {
  stage: "reranking",
  provider: "cohere",
  endpoint: "https://api.cohere.example",
  model: "rerank-v4.0-pro",
  credentialEnv: "QMDX_TEST_RERANKING_KEY",
};

const ENV = {
  QMDX_TEST_EXPANSION_KEY: "cache-secret-key",
  QMDX_TEST_RERANKING_KEY: "rerank-secret-key",
};

const EXPANSION_RATE: RateCardEntry = {
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://api.openai.example/v1",
  currency: "USD",
  usdPerMillionInputTokens: 0.15,
  usdPerMillionOutputTokens: 0.6,
  usdPerThousandSearchQueries: null,
  reviewedOnIsoDate: "2026-08-24",
};

const RATE: RateCardEntry = {
  provider: "cohere",
  model: "rerank-v4.0-pro",
  endpoint: "https://api.cohere.example",
  currency: "USD",
  usdPerMillionInputTokens: 2,
  usdPerMillionOutputTokens: null,
  usdPerThousandSearchQueries: 2,
  reviewedOnIsoDate: "2026-08-24",
};

// Simple counting wrapper around a fixed successful expansion response.
function countedExpansionTransport(entries: unknown[]): {
  transport: ExpandTransport;
  count(): number;
} {
  let calls = 0;
  const transport = (async () => {
    calls += 1;
    return {
      status: 200,
      headers: {},
      json: async () => ({
        id: "resp-1",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                outcome: "expanded",
                queries: entries,
              }),
            },
          },
        ],
      }),
    };
  }) as ExpandTransport;
  return { transport, count: () => calls };
}

function poolEntry(rank: number, chunk: string): HybridQueryResult {
  return {
    file: `qmd://docs/${rank}.md`,
    displayPath: `${rank}.md`,
    title: `T${rank}`,
    body: `B${rank}`,
    bestChunk: chunk,
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
        contributions: [{ queryType: "original", rank: 1, weight: 2 }],
      },
      rerankScore: 0,
      blendedScore: 1 / rank,
    },
  } as unknown as HybridQueryResult;
}

function rerankTransport(): { transport: RerankTransport; count(): number } {
  let calls = 0;
  const transport = (async (_url, init) => {
    calls += 1;
    const parsed = JSON.parse(init.body) as { documents: unknown[] };
    return {
      status: 200,
      headers: {},
      json: async () => ({
        id: "rerank-1",
        results: parsed.documents.map((_, index) => ({
          index,
          relevance_score: 0.25 + index / 100,
        })),
      }),
    };
  }) as RerankTransport;
  return { transport, count: () => calls };
}

function binding(dirName: string) {
  return {
    store: createFileResponseStore({
      directory: join(mkdtempSync(join(tmpdir(), "qmdx-stage-cache-")), dirName),
      maxEntries: 32,
      ttlMs: 3_600_000,
      clock: manualClock(),
    }),
    privacyFingerprint: "privacy-fingerprint-1",
  };
}

describe("expansion stage cache", () => {
  const ENTRIES = [
    { type: "lex", query: "vector store internals", language: "en", purpose: "terminology" },
  ];

  it("serves the second identical input entirely from cache with zero attempts and zero cost", async () => {
    const first = countedExpansionTransport(ENTRIES);
    const cache = binding("expansion");
    const deps = {
      env: ENV,
      transport: first.transport,
      pricing: { rateFor: () => EXPANSION_RATE },
      expansionCache: cache,
    };

    const miss = await runExpansionStage(
      { plainQuery: "vector databases" },
      EXPANSION_ROUTE,
      deps,
    );
    expect(first.count()).toBe(1);
    expect(miss.status).toBe("expanded");
    expect(miss.metadata).toMatchObject({
      attempts: 1,
      retries: 0,
      costUsd: expect.any(Number),
      cache: "miss",
    });

    // No credentials available and a failing transport: the cached entry
    // still serves the identical input.
    const failing = (() => {
      throw new Error("must not transmit on a cache hit");
    }) as unknown as ExpandTransport;
    const hit = await runExpansionStage({ plainQuery: "vector databases" }, EXPANSION_ROUTE, {
      env: {},
      transport: failing,
      expansionCache: cache,
      clock: manualClock(),
    });
    expect(hit.status).toBe("expanded");
    expect(hit.generatedQueries).toEqual(miss.generatedQueries);
    expect(hit.warning).toBeNull();
    expect(hit.metadata).toEqual({
      attempts: 0,
      retries: 0,
      costUsd: 0,
      cache: "hit",
    });
  });

  it("treats a different query, model, or privacy declaration as a different identity", async () => {
    const cache = binding("identity");
    const transmissionsOf = async (
      route: EffectiveRoute,
      plainQuery = "some query",
      bindingOverride = cache,
    ): Promise<number> => {
      const { transport, count } = countedExpansionTransport(ENTRIES);
      await runExpansionStage(
        { plainQuery },
        route,
        {
          env: ENV,
          pricing: { rateFor: () => EXPANSION_RATE },
          transport,
          ...(bindingOverride === undefined
            ? {}
            : { expansionCache: bindingOverride }),
        },
      );
      return count();
    };

    // First run transmits; identical repeat is served from cache.
    expect(await transmissionsOf(EXPANSION_ROUTE)).toBe(1);
    expect(
      (await runExpansionStage({ plainQuery: "some query" }, EXPANSION_ROUTE, {
        env: {},
        transport: (() => {
          throw new Error("cache hit");
        }) as unknown as ExpandTransport,
        expansionCache: cache,
      })).metadata.cache,
    ).toBe("hit");

    // Different model -> miss.
    expect(
      await transmissionsOf({ ...EXPANSION_ROUTE, model: "gpt-4o" }),
    ).toBe(1);
    // Different endpoint -> miss.
    expect(
      await transmissionsOf({
        ...EXPANSION_ROUTE,
        endpoint: "https://other.example/v1",
      }),
    ).toBe(1);
    // Different privacy declaration fingerprint -> miss.
    expect(
      await transmissionsOf(EXPANSION_ROUTE, "some query", {
        ...cache,
        privacyFingerprint: "privacy-fingerprint-2",
      }),
    ).toBe(1);
    // Different query text -> miss.
    expect(
      await transmissionsOf(EXPANSION_ROUTE, "another query"),
    ).toBe(1);
  });
});

describe("reranking stage cache", () => {
  const POOL = [poolEntry(1, "CHUNK ONE"), poolEntry(2, "CHUNK TWO")];

  function depsWith(cache = binding("reranking")) {
    const { transport, count } = rerankTransport();
    return {
      deps: {
        env: ENV,
        pricing: { rateFor: () => RATE },
        transport,
        rerankCache: cache,
        sleep: async () => undefined,
        rng: () => 0,
      },
      cache,
      transmissions: count,
    };
  }

  it("caches validated scores keyed by ordered candidate identities and chunk hashes", async () => {
    const wired = depsWith();
    const first = await runRerankingStage(
      { pool: POOL, originalQuery: "q", intent: null },
      RERANK_ROUTE,
      wired.deps,
    );
    expect(first.report.status).toBe("ok");
    expect(first.metadata).toMatchObject({ attempts: 1, cache: "miss" });

    const second = await runRerankingStage(
      { pool: POOL, originalQuery: "q", intent: null },
      RERANK_ROUTE,
      wired.deps,
    );
    expect(second.report.status).toBe("ok");
    expect(wired.transmissions()).toBe(1);
    expect(second.metadata).toEqual({
      attempts: 0,
      retries: 0,
      costUsd: 0,
      cache: "hit",
    });
    expect([...second.remoteRerankScores!.values()]).toEqual([
      ...first.remoteRerankScores!.values(),
    ]);
  });

  it("reorders or edits candidates into distinct identities", async () => {
    const cache = binding("order");
    let transmissions = 0;
    const sharedTransport = (async (_url: string, init: { body: string }) => {
      transmissions += 1;
      const parsed = JSON.parse(init.body) as { documents: unknown[] };
      return {
        status: 200,
        headers: {},
        json: async () => ({
          id: "r",
          results: parsed.documents.map((_, index) => ({
            index,
            relevance_score: 0.5,
          })),
        }),
      };
    }) as RerankTransport;

    const baseDeps = () => ({
      env: ENV,
      pricing: { rateFor: () => RATE },
      transport: sharedTransport,
      rerankCache: cache,
      sleep: async () => undefined,
      rng: () => 0,
    });

    await runRerankingStage(
      { pool: POOL, originalQuery: "q", intent: null },
      RERANK_ROUTE,
      baseDeps(),
    );
    expect(transmissions).toBe(1);
    // Same pool: hit.
    await runRerankingStage(
      { pool: POOL, originalQuery: "q", intent: null },
      RERANK_ROUTE,
      baseDeps(),
    );
    expect(transmissions).toBe(1);
    // Reordered pool: different ordered candidate identities -> miss.
    await runRerankingStage(
      { pool: [...POOL].reverse(), originalQuery: "q", intent: null },
      RERANK_ROUTE,
      baseDeps(),
    );
    expect(transmissions).toBe(2);
    // Edited selected chunk -> different chunk hash -> miss.
    await runRerankingStage(
      {
        pool: [poolEntry(1, "CHUNK ONE EDITED"), POOL[1]!],
        originalQuery: "q",
        intent: null,
      },
      RERANK_ROUTE,
      baseDeps(),
    );
    expect(transmissions).toBe(3);
  });

  it("persists only hashes and scores — never credentials or complete selected chunks", async () => {
    const cacheDir = join(
      mkdtempSync(join(tmpdir(), "qmdx-content-")),
      "reranking",
    );
    const cache = {
      store: createFileResponseStore({
        directory: cacheDir,
        maxEntries: 8,
        ttlMs: 3_600_000,
        clock: manualClock(),
      }),
      privacyFingerprint: "fp",
    };
    await runRerankingStage(
      { pool: POOL, originalQuery: "ORIGINAL QUERY MARKER", intent: null },
      RERANK_ROUTE,
      {
        env: ENV,
        pricing: { rateFor: () => RATE },
        transport: rerankTransport().transport,
        rerankCache: cache,
        sleep: async () => undefined,
        rng: () => 0,
      },
    );
    const files = readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const name of files) {
      const raw = readFileSync(join(cacheDir, name), "utf8");
      expect(raw).not.toContain("CHUNK ONE");
      expect(raw).not.toContain("CHUNK TWO");
      expect(raw).not.toContain("ORIGINAL QUERY MARKER");
      expect(raw).not.toContain("cache-secret-key");
      // The stored response is the score array.
      const parsed = JSON.parse(raw) as { response: unknown };
      expect(Array.isArray(parsed.response)).toBe(true);
    }
    expect(existsSync(join(cacheDir, files[0]!))).toBe(true);
  });
});

describe("cache hits through the orchestrated pipeline", () => {
  const ENTRIES = [
    {
      type: "lex",
      query: "vector store internals",
      language: "en",
      purpose: "terminology",
    },
  ];

  it("surfaces cache state in envelope metadata so acceptance runs can be filtered", async () => {
    const expansion = binding("pipe-expansion");
    const reranking = binding("pipe-reranking");
    let transmissions = 0;
    // One dual-mode transport serving both stage shapes by URL.
    const dualTransport = (async (url: string, init: { body: string }) => {
      transmissions += 1;
      if (url.includes("chat/completions")) {
        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: "resp-1",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    outcome: "expanded",
                    queries: ENTRIES,
                  }),
                },
              },
            ],
          }),
        };
      }
      const parsed = JSON.parse(init.body) as { documents: unknown[] };
      return {
        status: 200,
        headers: {},
        json: async () => ({
          id: "rerank-1",
          results: parsed.documents.map((_, index) => ({
            index,
            relevance_score: 0.5,
          })),
        }),
      };
    }) as unknown as RerankTransport;

    const request = {
      originalQuery: "vector databases",
      plainQuery: "vector databases",
      routes: [],
      intent: null,
      collections: [],
      limit: 10,
      minScore: null,
      full: false,
      explain: false,
      noExpand: false,
      noRerank: false,
    };

    const deps = {
      env: ENV,
      pricing: {
        rateFor: (provider: string) =>
          provider === "cohere" ? RATE : EXPANSION_RATE,
      },
      transport: dualTransport,
      fetchPool: async () => [
        poolEntry(1, "CHUNK ONE"),
        poolEntry(2, "CHUNK TWO"),
      ],
      effectiveProfile: {
        name: "test",
        expansion: EXPANSION_ROUTE,
        reranking: RERANK_ROUTE,
      },
      expansionCache: expansion,
      rerankCache: reranking,
    } as unknown as Parameters<typeof runQuery>[1];

    const first = await runQuery(request, deps);
    expect(first.envelope.pipeline.expansion.metadata.cache).toBe("miss");
    expect(first.envelope.pipeline.reranking.metadata.cache).toBe("miss");

    const second = await runQuery(request, deps);
    const { pipeline } = second.envelope;
    // Cache hits surface as fully valid stage statuses.
    expect(pipeline.status).toBe("ok");
    expect(pipeline.expansion.status).toBe("expanded");
    expect(pipeline.reranking.status).toBe("ok");
    expect(pipeline.expansion.metadata.cache).toBe("hit");
    expect(pipeline.reranking.metadata.cache).toBe("hit");
    expect(pipeline.expansion.metadata.costUsd).toBe(0);
    expect(pipeline.reranking.metadata.costUsd).toBe(0);
    expect(pipeline.expansion.metadata.attempts).toBe(0);
    expect(pipeline.reranking.metadata.attempts).toBe(0);
    // Timing remains visible for cached runs.
    expect(second.envelope.timingMs.total).toBeGreaterThanOrEqual(0);

    // Exactly two provider requests ever happened (one per stage).
    expect(transmissions).toBe(2);
  });
});
