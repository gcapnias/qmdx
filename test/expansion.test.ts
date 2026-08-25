import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { manualClock } from "../src/core/clock.js";
import { DEFAULT_EXPANSION_STAGE_BUDGET_MS } from "../src/core/budgets.js";
import {
  MAX_EXPANSION_INPUT_CHARS,
  conservativeTokenUpperBound,
  estimateWorstCaseAttemptCostUsd,
  ExpansionInputError,
  admitExpansionInput,
  estimateExpansionAttemptShape,
} from "../src/expand/admission.js";
import {
  EXPANSION_RESPONSE_JSON_SCHEMA,
  EXPANSION_SYSTEM_PROMPT,
} from "../src/expand/schema.js";
import {
  MAX_COUNT_BY_TYPE,
  MAX_LENGTH_BY_TYPE,
  validateEntry,
  validateGeneratedQueries,
} from "../src/expand/validate.js";
import {
  ATTEMPT_TIMEOUT_ERROR_NAME,
  buildExpansionRequest,
  classifyFailure,
  executeExpansionAttempt,
  defaultExpandTransport,
  validateExpansionResponse,
  InvalidProviderResponseError,
  type ExpandTransport,
} from "../src/expand/openai.js";
import { runExpansionStage } from "../src/expand/stage.js";
import type { EffectiveRoute } from "../src/config/resolve.js";
import type { RateCardEntry } from "../src/core/pricing.js";

const ROUTE: EffectiveRoute = {
  stage: "expansion",
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-4o-mini",
  credentialEnv: "QMDX_TEST_EXPANSION_KEY",
};

const ENV = { QMDX_TEST_EXPANSION_KEY: "expansion-secret-key" };

const RATE: RateCardEntry = {
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://api.openai.example/v1",
  currency: "USD",
  usdPerMillionInputTokens: 0.15,
  usdPerMillionOutputTokens: 0.6,
  usdPerThousandSearchQueries: null,
  reviewedOnIsoDate: "2026-08-24",
};

function entry(
  overrides: Record<string, unknown> = {},
): { type: string; query: string; language: string; purpose: string } &
  Record<string, unknown> {
  return {
    type: "lex",
    query: "vector database internals",
    language: "en",
    purpose: "terminology",
    ...overrides,
  };
}

function expandedBody(entries: unknown[]): unknown {
  return {
    id: "resp-1",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({ outcome: "expanded", queries: entries }),
        },
      },
    ],
  };
}

function sufficientBody(): unknown {
  return {
    id: "resp-2",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            outcome: "original_sufficient",
            queries: [],
          }),
        },
      },
    ],
  };
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  timeoutMs?: number;
}

function stubTransport(
  handler: (call: RecordedCall, attempt: number) =>
    | { status: number; headers?: Record<string, string>; body?: unknown }
    | Promise<never>,
): ExpandTransport & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport = (async (url, init) => {
    const call: RecordedCall = {
      url,
      headers: init.headers,
      bodyText: init.body,
      timeoutMs: init.timeoutMs,
    };
    calls.push(call);
    const response = await handler(call, calls.length);
    return {
      status: response.status,
      headers: response.headers ?? {},
      json: async () => response.body,
    };
  }) as ExpandTransport & { calls: RecordedCall[] };
  return Object.assign(transport, { calls });
}

describe("expansion payload construction", () => {
  it("posts the strict JSON Schema request to the chat-completions route", () => {
    const built = buildExpansionRequest(ROUTE, "secret-key", "find things");
    expect(built.url).toBe("https://api.openai.example/v1/chat/completions");
    expect(built.init.method).toBe("POST");
    expect(built.init.headers.Authorization).toBe("Bearer secret-key");
    const parsed = JSON.parse(built.serializedBody) as {
      model: string;
      temperature: number;
      response_format: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: unknown };
      };
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.model).toBe("gpt-4o-mini");
    // Lowest deterministic sampling settings.
    expect(parsed.temperature).toBe(0);
    expect(parsed.response_format.type).toBe("json_schema");
    expect(parsed.response_format.json_schema.strict).toBe(true);
    expect(parsed.response_format.json_schema.name).toBe("qmdx_expansion");
    expect(parsed.response_format.json_schema.schema).toEqual(
      EXPANSION_RESPONSE_JSON_SCHEMA,
    );
  });

  it("sends only the original query as user content", () => {
    const built = buildExpansionRequest(
      ROUTE,
      "secret-key",
      "sqlite wal checkpointing",
    );
    const parsed = JSON.parse(built.serializedBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]!.role).toBe("system");
    expect(parsed.messages[0]!.content).toBe(EXPANSION_SYSTEM_PROMPT);
    expect(parsed.messages[1]!.role).toBe("user");
    expect(parsed.messages[1]!.content).toBe("sqlite wal checkpointing");
  });

  it("never transmits intent, corpus content, retrieved documents, paths, or history", () => {
    const INTENT_MARKER = "INTENT-MARKER-compare-engines";
    const CORPUS_MARKER = "CORPUS-BODY-MARKER-xyzzy";
    const DOCUMENT_MARKER = "RETRIEVED-DOC-MARKER";
    const PATH_MARKER = "qmd://notes/SECRET-PATH.md";
    const HISTORY_MARKER = "HISTORY-QUERY-MARKER";
    const built = buildExpansionRequest(
      ROUTE,
      "secret-key",
      "wal checkpoint sizing",
    );
    const wire = `${built.serializedBody}\n${EXPANSION_SYSTEM_PROMPT}`;
    expect(wire).not.toContain(INTENT_MARKER);
    expect(wire).not.toContain(CORPUS_MARKER);
    expect(wire).not.toContain(DOCUMENT_MARKER);
    expect(wire).not.toContain(PATH_MARKER);
    expect(wire).not.toContain(HISTORY_MARKER);
    // And nothing beyond the exact original query reaches the user turn.
    const parsed = JSON.parse(built.serializedBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(
      built.serializedBody.indexOf("wal checkpoint sizing"),
    ).toBeGreaterThan(-1);
  });
});

describe("expansion input admission", () => {
  it("admits a normal query unchanged", () => {
    expect(admitExpansionInput("find things")).toBe("find things");
  });

  it("rejects an oversized query instead of truncating it", () => {
    const oversized = "x".repeat(MAX_EXPANSION_INPUT_CHARS + 1);
    expect(() => admitExpansionInput(oversized)).toThrow(ExpansionInputError);
  });

  it("rejects an empty query locally without transmitting", async () => {
    const transport = stubTransport(() => ({ status: 200, body: sufficientBody() }));
    const outcome = await runExpansionStage(
      { plainQuery: "   " },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => RATE } },
    );
    expect(outcome.status).toBe("degraded");
    expect(outcome.reason).toBe("payload_limit_exceeded");
    expect(outcome.warning?.code).toBe("payload_limit_exceeded");
    expect(transport.calls).toHaveLength(0);
  });

  it("bounds tokens conservatively above any plausible tokenizer count", () => {
    const text = "y".repeat(300);
    expect(conservativeTokenUpperBound(text)).toBe(Math.ceil(300 / 3) + 16);
  });

  it("estimates worst-case cost from the maximal schema-valid output", () => {
    const shape = estimateExpansionAttemptShape(EXPANSION_SYSTEM_PROMPT, "find things");
    expect(shape.outputTokensUpperBound)
      .toBeGreaterThanOrEqual(Math.ceil((2 * 256 + 512 + 1200) / 3));
    const cost = estimateWorstCaseAttemptCostUsd(shape, RATE);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it("refuses cost admission without reviewed pricing", () => {
    const shape = estimateExpansionAttemptShape(EXPANSION_SYSTEM_PROMPT, "q");
    expect(() => estimateWorstCaseAttemptCostUsd(shape, null)).toThrow(
      /reviewed pricing/,
    );
  });
});

describe("generated-query validation and ordering", () => {
  it("keeps valid entries and discards invalid ones independently", () => {
    const result = validateGeneratedQueries([
      entry(),
      entry({ language: "fr" }),
      entry({ purpose: "semantic" }),
      entry({ type: "vec" as string, purpose: "semantic", query: "v".repeat(100) }),
    ], "original query");
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]!.type).toBe("lex");
    expect(result.queries[1]!.type).toBe("vec");
    expect(result.discardedCount).toBe(2);
  });

  it("normalizes surrounding and internal whitespace", () => {
    const validated = validateEntry({
      type: "lex",
      query: "  vector   stores\nin\tnotes  ",
      language: "en",
      purpose: "terminology",
    });
    expect(validated!.query).toBe("vector stores in notes");
  });

  it("rejects control characters", () => {
    expect(validateEntry({
      type: "lex",
      query: "bad\u0000query",
      language: "en",
      purpose: "terminology",
    })).toBeNull();
    expect(validateEntry({
      type: "lex",
      query: "bad\u001Fquery",
      language: "en",
      purpose: "terminology",
    })).toBeNull();
    expect(validateEntry({
      type: "lex",
      query: "bad\u007Fquery",
      language: "en",
      purpose: "terminology",
    })).toBeNull();
  });

  it("enforces per-type purposes", () => {
    expect(validateEntry(entry({ purpose: "hypothetical" }))).toBeNull();
    expect(validateEntry(entry({
      type: "hyde",
      purpose: "terminology",
      query: "passage",
    }))).toBeNull();
    expect(validateEntry(entry({
      type: "vec",
      purpose: "translation",
      query: "rewrite",
    }))).toBeNull();
  });

  it("enforces per-type maximum lengths in Unicode characters", () => {
    expect(validateEntry(entry({ query: "x".repeat(257) }))).toBeNull();
    expect(validateEntry(entry({ query: "x".repeat(256) }))).not.toBeNull();
    expect(validateEntry(entry({
      type: "vec",
      purpose: "semantic",
      query: "\u03ba".repeat(513),
    }))).toBeNull();
    expect(validateEntry(entry({
      type: "vec",
      purpose: "semantic",
      query: "\u03ba".repeat(512),
    }))).not.toBeNull();
    expect(validateEntry(entry({
      type: "hyde",
      purpose: "hypothetical",
      query: "h".repeat(1201),
    }))).toBeNull();
    expect(MAX_LENGTH_BY_TYPE.lex).toBe(256);
    expect(MAX_LENGTH_BY_TYPE.vec).toBe(512);
    expect(MAX_LENGTH_BY_TYPE.hyde).toBe(1200);
  });

  it("removes case-insensitive duplicates within a type but keeps the text across types", () => {
    const result = validateGeneratedQueries([
      entry({ query: "Graph Engine Internals" }),
      entry({ query: "graph engine internals" }),
      entry({
        type: "vec",
        purpose: "semantic",
        query: "GRAPH ENGINE INTERNALS",
      }),
    ], "original");
    expect(result.queries.map((query) => query.type)).toEqual(["lex", "vec"]);
    expect(result.discardedCount).toBe(1);
  });

  it("removes generated copies of the corresponding original route", () => {
    const result = validateGeneratedQueries([
      entry({ query: "Find Things" }),
      entry({
        type: "vec",
        purpose: "semantic",
        query: "find things",
      }),
    ], "find things");
    expect(result.queries).toHaveLength(0);
    expect(result.discardedCount).toBe(2);
  });

  it("enforces per-type counts, keeping the highest-priority variants", () => {
    const result = validateGeneratedQueries([
      entry({ query: "third lexical", purpose: "translation" }),
      entry({ query: "second lexical" }),
      entry({ query: "first lexical" }),
    ], "original");
    expect(MAX_COUNT_BY_TYPE.lex).toBe(2);
    // Canonical order ranks terminology before translation; equal-rank
    // entries keep provider order.
    expect(result.queries.map((query) => query.query)).toEqual([
      "second lexical",
      "first lexical",
    ]);
    expect(result.discardedCount).toBe(1);
  });

  it("orders survivors canonically: terminology lex, translation lex, vec, hyde", () => {
    const result = validateGeneratedQueries([
      entry({
        type: "hyde",
        purpose: "hypothetical",
        query: "A plausible note passage.",
      }),
      entry({
        type: "vec",
        purpose: "semantic",
        query: "semantic rewrite",
      }),
      entry({ query: "translation variant", purpose: "translation", language: "el" }),
      entry({ query: "terminology variant" }),
    ], "original");
    expect(result.queries.map((query) => query.purpose)).toEqual([
      "terminology",
      "translation",
      "semantic",
      "hypothetical",
    ]);
  });
});

describe("provider-response validation", () => {
  it("accepts a well-formed expanded response", () => {
    const parsed = validateExpansionResponse(expandedBody([entry()]));
    expect(parsed.outcome).toBe("expanded");
    expect(parsed.entries).toHaveLength(1);
  });

  it("accepts an original_sufficient response only with zero queries", () => {
    const parsed = validateExpansionResponse(sufficientBody());
    expect(parsed.outcome).toBe("original_sufficient");
    expect(parsed.entries).toHaveLength(0);
    expect(() =>
      validateExpansionResponse(expandedBody([])),
    ).not.toThrow();
  });

  it.each([
    ["non-object body", null],
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    [
      "multiple choices",
      {
        choices: [
          { finish_reason: "stop", message: { content: "{}" } },
          { finish_reason: "stop", message: { content: "{}" } },
        ],
      },
    ],
    [
      "truncated finish reason",
      { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
    ],
    [
      "missing content",
      { choices: [{ finish_reason: "stop", message: {} }] },
    ],
    [
      "non-JSON content",
      { choices: [{ finish_reason: "stop", message: { content: "nope{" } }] },
    ],
    [
      "non-closed outcome",
      {
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({ outcome: "maybe", queries: [] }),
          },
        }],
      },
    ],
    [
      "queries not an array",
      {
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({ outcome: "expanded", queries: 4 }),
          },
        }],
      },
    ],
    [
      "entry missing a field",
      expandedBody([{ type: "lex", query: "q", language: "en" }]),
    ],
    [
      "original_sufficient with queries",
      {
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              outcome: "original_sufficient",
              queries: [entry()],
            }),
          },
        }],
      },
    ],
  ])("rejects %s", (_label, body) => {
    expect(() => validateExpansionResponse(body)).toThrow(
      InvalidProviderResponseError,
    );
  });
});

describe("failure classification", () => {
  it("maps authentication failures to a non-retryable reason", () => {
    expect(classifyFailure(null, 401)).toMatchObject({
      reason: "authentication_failed",
      retryable: false,
    });
    expect(classifyFailure(null, 403).retryable).toBe(false);
  });

  it("maps billing/quota exhaustion to a non-retryable reason", () => {
    expect(classifyFailure(null, 402)).toMatchObject({
      reason: "billing_or_quota_exhausted",
      retryable: false,
    });
  });

  it("maps missing capability to a non-retryable reason", () => {
    expect(classifyFailure(null, 404)).toMatchObject({
      reason: "unsupported_capability",
      retryable: false,
    });
  });

  it("maps transient HTTP statuses to retryable reasons", () => {
    expect(classifyFailure(null, 408)).toMatchObject({ reason: "timeout", retryable: true });
    expect(classifyFailure(null, 429)).toMatchObject({ reason: "rate_limited", retryable: true });
    expect(classifyFailure(null, 500)).toMatchObject({ reason: "provider_unavailable", retryable: true });
    expect(classifyFailure(null, 503).retryable).toBe(true);
  });

  it("classifies timeouts and transport errors", () => {
    const timeout = new Error("too slow");
    timeout.name = ATTEMPT_TIMEOUT_ERROR_NAME;
    expect(classifyFailure(timeout, null)).toMatchObject({
      reason: "timeout",
      retryable: true,
    });
    expect(classifyFailure(new Error("socket hung up"), null)).toMatchObject({
      reason: "transport_error",
      retryable: true,
    });
    expect(classifyFailure(new InvalidProviderResponseError("bad"), null))
      .toMatchObject({ reason: "invalid_provider_response", retryable: true });
  });

  it("treats any other HTTP status as provider policy rejection", () => {
    expect(classifyFailure(null, 418)).toMatchObject({
      reason: "provider_policy_rejected",
      retryable: false,
    });
  });
});

describe("expansion stage orchestration", () => {
  it("returns validated generated queries on success", async () => {
    const transport = stubTransport(() => ({
      status: 200,
      body: expandedBody([
        entry({ query: "  lexical   variant " }),
        entry({ language: "fr" }),
      ]),
    }));
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => RATE } },
    );
    expect(outcome.status).toBe("expanded");
    expect(outcome.reason).toBeNull();
    expect(outcome.warning).toBeNull();
    expect(outcome.generatedQueries).toHaveLength(1);
    expect(outcome.generatedQueries[0]).toEqual({
      type: "lex",
      query: "lexical variant",
      language: "en",
      purpose: "terminology",
    });
  });

  it("reports original_sufficient without generated queries", async () => {
    const transport = stubTransport(() => ({ status: 200, body: sufficientBody() }));
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => RATE } },
    );
    expect(outcome.status).toBe("original_sufficient");
    expect(outcome.generatedQueries).toEqual([]);
    expect(outcome.warning).toBeNull();
  });

  it("retries once after a transient failure and succeeds", async () => {
    const transport = stubTransport((_call, attempt) => {
      if (attempt === 1) throw new Error("connection reset");
      return { status: 200, body: expandedBody([entry()]) };
    });
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      {
        transport,
        env: ENV,
        pricing: { rateFor: () => RATE },
        rng: () => 0,
        sleep: async () => {},
      },
    );
    expect(outcome.status).toBe("expanded");
    expect(transport.calls).toHaveLength(2);
  });

  it("degrades with a stable warning after exhausting the single retry", async () => {
    const transport = stubTransport(() => ({ status: 503, body: { error: "down" } }));
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      {
        transport,
        env: ENV,
        pricing: { rateFor: () => RATE },
        rng: () => 0,
        sleep: async () => {},
      },
    );
    expect(outcome.status).toBe("degraded");
    expect(outcome.reason).toBe("provider_unavailable");
    expect(outcome.generatedQueries).toEqual([]);
    expect(outcome.warning).toMatchObject({
      stage: "expansion",
      code: "provider_unavailable",
      retryable: true,
    });
    expect(transport.calls).toHaveLength(2);
  });

  it("never retries authentication failures", async () => {
    const transport = stubTransport(() => ({ status: 401, body: {} }));
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => RATE } },
    );
    expect(outcome.reason).toBe("authentication_failed");
    expect(outcome.warning?.retryable).toBe(false);
    expect(transport.calls).toHaveLength(1);
  });

  it("survives partial valid expansion without retrying", async () => {
    const transport = stubTransport(() => ({
      status: 200,
      body: expandedBody([
        entry({ query: "good variant" }),
        entry({ language: "fr" }),
        entry({ query: "x".repeat(300) }),
      ]),
    }));
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => RATE } },
    );
    expect(outcome.status).toBe("expanded");
    expect(outcome.generatedQueries).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("retries once when every entry fails validation, then degrades", async () => {
    const transport = stubTransport(() => ({
      status: 200,
      body: expandedBody([entry({ language: "fr" })]),
    }));
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      {
        transport,
        env: ENV,
        pricing: { rateFor: () => RATE },
        rng: () => 0,
        sleep: async () => {},
      },
    );
    expect(outcome.status).toBe("degraded");
    expect(outcome.reason).toBe("invalid_provider_response");
    expect(transport.calls).toHaveLength(2);
  });

  it("does not transmit anything when the input exceeds the payload limit", async () => {
    const transport = stubTransport(() => ({ status: 200, body: sufficientBody() }));
    const outcome = await runExpansionStage(
      { plainQuery: "q".repeat(MAX_EXPANSION_INPUT_CHARS + 1) },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => RATE } },
    );
    expect(outcome.reason).toBe("payload_limit_exceeded");
    expect(outcome.warning?.retryable).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses attempts whose worst-case cost cannot fit the query ceiling", async () => {
    const transport = stubTransport(() => ({ status: 200, body: sufficientBody() }));
    const expensive: RateCardEntry = {
      ...RATE,
      usdPerMillionOutputTokens: 10_000,
    };
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => expensive } },
    );
    expect(outcome.reason).toBe("cost_budget_exceeded");
    expect(transport.calls).toHaveLength(0);
  });

  it("degrades when the cumulative stage budget runs out mid-stage", async () => {
    const clock = manualClock();
    const transport = stubTransport((_call, attempt) => {
      if (attempt === 1) {
        // The first attempt consumes the whole stage budget.
        clock.advance(DEFAULT_EXPANSION_STAGE_BUDGET_MS + 1);
        return { status: 503, body: {} };
      }
      return { status: 200, body: sufficientBody() };
    });
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      {
        transport,
        env: ENV,
        pricing: { rateFor: () => RATE },
        clock,
        rng: () => 0,
        sleep: async () => {},
      },
    );
    expect(outcome.reason).toBe("stage_budget_exceeded");
    // The second attempt was never transmitted.
    expect(transport.calls).toHaveLength(1);
  });

  it("waits at most the provider-suggested Retry-After and only when it fits the budget", async () => {
    const waits: number[] = [];
    let attempt = 0;
    const transport = stubTransport(() => {
      attempt++;
      if (attempt === 1) {
        return { status: 429, headers: { "retry-after": "2" }, body: {} };
      }
      return { status: 200, body: sufficientBody() };
    });
    const outcome = await runExpansionStage(
      { plainQuery: "original query" },
      ROUTE,
      {
        transport,
        env: ENV,
        pricing: { rateFor: () => RATE },
        rng: () => 0.999,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(outcome.status).toBe("original_sufficient");
    expect(waits).toEqual([2000]);
  });

  it("propagates local configuration faults instead of degrading", async () => {
    const transport = stubTransport(() => ({ status: 200, body: sufficientBody() }));
    await expect(runExpansionStage(
      { plainQuery: "q" },
      ROUTE,
      { transport, env: {}, pricing: { rateFor: () => RATE } },
    )).rejects.toMatchObject({ code: "missing_credentials" });
    await expect(runExpansionStage(
      { plainQuery: "q" },
      ROUTE,
      { transport, env: ENV, pricing: { rateFor: () => null } },
    )).rejects.toMatchObject({ code: "invalid_profile" });
  });
});

describe("default transport against a live local stub", () => {
  function startStub(): Promise<{
    server: Server;
    url: string;
    requests: Array<{ authorization: string | undefined; bodyText: string }>;
  }> {
    const requests: Array<{ authorization: string | undefined; bodyText: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          authorization: req.headers.authorization,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sufficientBody()));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null
          ? address.port
          : 0;
        resolve({
          server,
          url: `http://127.0.0.1:${port}/v1/chat/completions`,
          requests,
        });
      });
    });
  }

  it("transmits only the original query over the wire", async () => {
    const stub = await startStub();
    try {
      const response = await defaultExpandTransport(stub.url, {
        method: "POST",
        headers: { Authorization: "Bearer wire-secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "wire audit query" }],
        }),
        timeoutMs: 5000,
      });
      expect(response.status).toBe(200);
      const parsed = await response.json() as {
        choices: unknown[];
      };
      expect(Array.isArray(parsed.choices)).toBe(true);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.authorization).toBe("Bearer wire-secret");
      const INTENT_MARKER = "INTENT-MARKER";
      const PATH_MARKER = "qmd://notes/SECRET-PATH.md";
      const CORPUS_MARKER = "CORPUS-BODY-MARKER";
      expect(stub.requests[0]!.bodyText).toContain("wire audit query");
      expect(stub.requests[0]!.bodyText).not.toContain(INTENT_MARKER);
      expect(stub.requests[0]!.bodyText).not.toContain(PATH_MARKER);
      expect(stub.requests[0]!.bodyText).not.toContain(CORPUS_MARKER);
    } finally {
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    }
  });

  it("executes a full attempt through executeExpansionAttempt against the stub", async () => {
    const stub = await startStub();
    try {
      const parsed = await executeExpansionAttempt(
        { ...ROUTE, endpoint: stub.url.replace("/chat/completions", "") },
        "attempt-secret",
        "attempt audit query",
        defaultExpandTransport,
        5000,
      );
      expect(parsed.outcome).toBe("original_sufficient");
      const wire = stub.requests[0]!;
      expect(wire.bodyText).toContain("attempt audit query");
      expect(wire.bodyText).not.toContain("attempt-secret");
    } finally {
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    }
  });
});
