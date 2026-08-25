import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestIndex,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import {
  CAPTURE_RETENTION_CHOICES,
  CAPTURE_WARNING_MESSAGE,
  activateProtectedDestination,
  captureWrapTransport,
  createPayloadSink,
  resolveCaptureConfig,
} from "../src/core/capture.js";
import { runRerankingStage } from "../src/rerank/stage.js";
import type { RerankTransport } from "../src/rerank/cohere.js";
import type { EffectiveRoute } from "../src/config/resolve.js";
import type { RateCardEntry } from "../src/core/pricing.js";

const POSIX = process.platform !== "win32";

let index: TestIndex;

beforeAll(async () => {
  index = await createTestIndex({
    "alpha.md": "# Alpha\n\nVector embeddings power search.\n",
  });
}, 240000);

afterAll(() => {
  void index;
});

const RERANK_ROUTE: EffectiveRoute = {
  stage: "reranking",
  provider: "cohere",
  endpoint: "https://api.cohere.example",
  model: "rerank-v4.0-pro",
  credentialEnv: "QMDX_TEST_CAPTURE_KEY",
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

describe("capture configuration resolution", () => {
  it("is inactive by default and fails closed on partial or invalid configuration", () => {
    expect(resolveCaptureConfig({})).toBeNull();
    expect(() =>
      resolveCaptureConfig({ QMDX_CAPTURE_DIR: "" }),
    ).toThrow(/QMDX_CAPTURE_DIR/);
    expect(() => resolveCaptureConfig({ QMDX_CAPTURE_DIR: "/tmp/x" })).toThrow(
      /QMDX_CAPTURE_RETENTION/,
    );
    expect(() =>
      resolveCaptureConfig({
        QMDX_CAPTURE_DIR: "/tmp/x",
        QMDX_CAPTURE_RETENTION: "forever-and-ever",
      }),
    ).toThrow(/QMDX_CAPTURE_RETENTION/);
    expect(
      resolveCaptureConfig({
        QMDX_CAPTURE_DIR: "/tmp/x",
        QMDX_CAPTURE_RETENTION: "30d",
      }),
    ).toEqual({ dir: "/tmp/x", retention: "30d" });
    expect([...CAPTURE_RETENTION_CHOICES]).toEqual([
      "session",
      "30d",
      "indefinite",
    ]);
  });

  it("prepares the protected destination with a retention manifest and owner-only permissions", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "qmdx-capture-")), "dest");
    activateProtectedDestination({ dir, retention: "indefinite" });
    if (POSIX) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
    }
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.retention).toBe("indefinite");
    expect(manifest.warning).toBe(CAPTURE_WARNING_MESSAGE);
  });
});

describe("payload capture transport wrapper", () => {
  function entryFiles(dir: string): Array<Record<string, unknown>> {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>);
  }

  it("captures requests before transmission, responses after, and failures with rethrow", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "qmdx-sink-")), "sink");
    activateProtectedDestination({ dir, retention: "session" });
    const sink = createPayloadSink({ dir, retention: "session" });

    let attempts = 0;
    const flakyThenSuccess = (async (_url: string, init: { body: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      const parsed = JSON.parse(init.body) as { documents: unknown[] };
      return {
        status: 200,
        headers: {},
        json: async () => ({
          id: "r",
          results: parsed.documents.map((_, i) => ({
            index: i,
            relevance_score: 0.5,
          })),
        }),
      };
    }) as RerankTransport;
    const wrapped = captureWrapTransport(
      flakyThenSuccess,
      sink,
      "reranking",
    ) as unknown as RerankTransport;

    // Two attempts (one retry) so both the failure and success paths record.
    const outcome = await runRerankingStage(
      {
        pool: [
          {
            file: "qmd://docs/a.md",
            displayPath: "a.md",
            title: "T",
            body: "B",
            bestChunk: "SECRET CHUNK TEXT",
            bestChunkPos: 1,
            context: null,
            score: 1,
            docid: "100001",
            explain: {
              ftsScores: [],
              vectorScores: [],
              rrf: {
                rank: 1,
                positionScore: 1,
                weight: 1,
                baseScore: 0,
                topRankBonus: 0,
                totalScore: 1,
                contributions: [],
              },
              rerankScore: 0,
              blendedScore: 1,
            },
          },
        ],
        originalQuery: "ORIGINAL QUERY",
        intent: null,
      },
      RERANK_ROUTE,
      {
        env: { QMDX_TEST_CAPTURE_KEY: "CAPTURED-CREDENTIAL" },
        pricing: { rateFor: () => RATE },
        transport: wrapped,
        sleep: async () => undefined,
        rng: () => 0,
      },
    );
    expect(outcome.report.status).toBe("ok");

    const entries = entryFiles(dir);
    const kinds = entries.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["failure", "request", "request", "response"]);
    for (const entry of entries) {
      if (entry.kind === "request") {
        const headers = entry.headers as Record<string, string>;
        expect(headers.Authorization).toBe("[redacted]");
        expect(JSON.stringify(entry)).not.toContain("CAPTURED-CREDENTIAL");
        // Protected capture intentionally contains payload content.
        expect(JSON.stringify(entry)).toContain("SECRET CHUNK TEXT");
      }
      if (entry.kind === "failure") {
        expect((entry.error as Record<string, unknown>).message).toContain(
          "ECONNRESET",
        );
      }
      if (entry.kind === "response") {
        expect(entry.status).toBe(200);
      }
    }
  });
});

describe("capture mode through the command layer", () => {
  it("warns on stderr, prepares the destination, and leaves the JSON envelope clean", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "qmdx-capture-cli-")), "d");
    const run = await runCli(
      ["query", "embeddings", "--format", "json"],
      index.root,
      {
        env: {
          QMDX_CAPTURE_DIR: dest,
          QMDX_CAPTURE_RETENTION: "session",
        },
      },
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("WARNING");
    expect(run.stderr).toContain(CAPTURE_WARNING_MESSAGE.slice(0, 40));
    expect(readFileSync(join(dest, "manifest.json"), "utf8")).toContain(
      '"retention": "session"',
    );
    const envelope = JSON.parse(run.stdout) as { schemaVersion: number };
    expect(envelope.schemaVersion).toBe(1);
    // The envelope itself never becomes the capture channel.
    expect(run.stdout).not.toContain("WARNING");
  });

  it("fails closed with an invocation error when retention is missing", async () => {
    const run = await runCli(["query", "embeddings"], index.root, {
      env: { QMDX_CAPTURE_DIR: join(tmpdir(), "qmdx-capture-missing") },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("QMDX_CAPTURE_RETENTION");
  });
});
