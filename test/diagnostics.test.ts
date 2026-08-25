import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestIndex,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import type { ResultEnvelope } from "../src/core/envelope.js";
import {
  appendDiagnosticRecord,
  buildDiagnosticRecord,
  redactDeep,
  redactSecrets,
} from "../src/core/diagnostics.js";

const DOCS = {
  "alpha.md":
    "# Alpha\n\nVector embeddings power semantic search across languages.\n",
};

const SECRET_QUERY = "CONFIDENTIAL QUERY MARKER";
const SECRET_INTENT = "CONFIDENTIAL INTENT MARKER";
const SECRET_CREDENTIAL = "super-secret-credential-value-9876";

let index: TestIndex;
let diagDir: string;

beforeAll(async () => {
  index = await createTestIndex(DOCS);
  diagDir = mkdtempSync(join(tmpdir(), "qmdx-diag-"));
}, 240000);

afterAll(() => {
  void index;
});

describe("diagnostic record projection", () => {
  const envelope = {
    schemaVersion: 1,
    query: {
      original: SECRET_QUERY,
      intent: SECRET_INTENT,
      collections: [],
    },
    pipeline: {
      status: "degraded",
      expansion: {
        status: "degraded",
        reason: "provider_unavailable",
        generatedQueries: [
          { type: "lex", query: "GENERATED MARKER", language: "en", purpose: "terminology" },
        ],
        metadata: { attempts: 0, retries: 0, costUsd: 0 },
      },
      retrieval: {
        status: "ok",
        reason: null,
        candidateCount: 3,
        engine: "qmd",
      },
      reranking: {
        status: "ok",
        reason: null,
        candidateCount: 3,
        metadata: { attempts: 1, retries: 0, costUsd: 0.001, cache: "miss" },
      },
    },
    results: [
      {
        rank: 1,
        docid: "#1",
        score: 1,
        file: "qmd://docs/PATH MARKER.md",
        title: "TITLE MARKER",
        context: null,
        line: 0,
        snippet: "SNIPPET MARKER",
        bestChunkMarker: "CHUNK MARKER",
      },
    ],
    warnings: [
      {
        stage: "reranking",
        code: "provider_unavailable",
        message: "No remote reranking route is configured.",
        retryable: false,
      },
    ],
    timingMs: { total: 10, expansion: 1, retrieval: 5, reranking: 2, overhead: 2 },
  } as unknown as ResultEnvelope;

  it("projects only approved metadata fields onto the record", () => {
    const record = buildDiagnosticRecord({
      envelope,
      profileName: "p",
      expansionRoute: { provider: "openai", model: "gpt-4o-mini" },
      rerankingRoute: { provider: "cohere", model: "rerank-v4.0-pro" },
      privacyDeclarationVersion: 3,
      recordedAtMs: 1234,
    });
    expect(Object.keys(record).sort()).toEqual([
      "expansion",
      "expansionModel",
      "expansionProvider",
      "pipelineStatus",
      "privacyDeclarationVersion",
      "profile",
      "recordedAtMs",
      "reranking",
      "rerankingModel",
      "rerankingProvider",
      "retrieval",
      "schemaVersion",
      "timingMs",
      "warnings",
    ]);
    expect(record.expansion.generatedQueryCount).toBe(1);
    expect(record.reranking.cache).toBe("miss");
    expect(record.reranking.costUsd).toBe(0.001);
    expect(record.retrieval.candidateCount).toBe(3);
  });

  it("never persists queries, intent, generated queries, chunks, paths, headers, or bodies", () => {
    const record = buildDiagnosticRecord({
      envelope,
      profileName: "p",
      expansionRoute: null,
      rerankingRoute: null,
      privacyDeclarationVersion: null,
      recordedAtMs: 1234,
    });
    const serialized = JSON.stringify(record);
    for (const forbidden of [
      SECRET_QUERY,
      SECRET_INTENT,
      "GENERATED MARKER",
      "CHUNK MARKER",
      "SNIPPET MARKER",
      "PATH MARKER",
      "TITLE MARKER",
      "authorization",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("redacts matching secret values everywhere before persistence", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "qmdx-redact-")), "d");
    appendDiagnosticRecord(
      dir,
      {
        ...buildDiagnosticRecord({
          envelope,
          profileName: "p",
          expansionRoute: null,
          rerankingRoute: null,
          privacyDeclarationVersion: null,
          recordedAtMs: 1234,
        }),
        // Simulate any message accidentally carrying the credential value.
        warnings: [
          {
            stage: "expansion",
            code: "transport_error",
            retryable: true,
            message: `request failed with ${SECRET_CREDENTIAL} embedded`,
          },
        ],
      },
      [SECRET_CREDENTIAL],
    );
    const files = readdirSync(dir);
    expect(files).toEqual(["diagnostics.jsonl"]);
    const raw = readFileSync(join(dir, "diagnostics.jsonl"), "utf8");
    expect(raw).not.toContain(SECRET_CREDENTIAL);
    expect(raw).toContain("[redacted]");
  });

  it("redactDeep handles nested structures and short values are left alone", () => {
    expect(redactSecrets("a key-of-3 stays", ["key"])).toBe(
      "a key-of-3 stays",
    );
    expect(redactSecrets("token abc12345 inside", ["abc12345"])).toBe(
      "token [redacted] inside",
    );
    expect(
      redactDeep(
        { list: [{ nested: `x ${SECRET_CREDENTIAL} y` }], n: 1, b: true },
        [SECRET_CREDENTIAL],
      ),
    ).toEqual({ list: [{ nested: "x [redacted] y" }], n: 1, b: true });
  });
});

describe("default diagnostics persistence", () => {
  it("persists nothing by default and one metadata-only record per search when opted in", async () => {
    // Default run (no QMDX_DIAGNOSTICS_DIR): no persistence surface at all.
    const plain = await runCli(
      ["query", SECRET_QUERY, "--format", "json"],
      index.root,
    );
    expect(plain.status).toBe(0);
    expect(existsSync(join(index.root, "diagnostics.jsonl"))).toBe(false);

    // Opted-in run: exactly one record, metadata-only.
    const optIn = await runCli(
      ["query", SECRET_QUERY, "--format", "json", "--intent", SECRET_INTENT],
      index.root,
      { env: { QMDX_DIAGNOSTICS_DIR: diagDir } },
    );
    expect(optIn.status).toBe(0);
    expect(readdirSync(diagDir)).toEqual(["diagnostics.jsonl"]);
    const lines = readFileSync(join(diagDir, "diagnostics.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const raw = lines[lines.length - 1]!;
    expect(raw).not.toContain(SECRET_QUERY);
    expect(raw).not.toContain(SECRET_INTENT);
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record.pipelineStatus).toBe("degraded");
    expect(record.schemaVersion).toBe(1);

    // The envelope itself still carries the query reflection (by design),
    // proving the diagnostic record is a deliberate projection, not a copy.
    const envelope = JSON.parse(optIn.stdout) as ResultEnvelope;
    expect(envelope.query.original).toBe(SECRET_QUERY);
  });

  it("keeps credentials out of error envelopes on failure paths", async () => {
    const run = await runCli(
      ["query", SECRET_QUERY, "--format", "json"],
      mkdtempSync(join(tmpdir(), "qmdx-noindex-")),
      {
        env: {
          QMDX_TEST_ERROR_KEY: SECRET_CREDENTIAL,
          QMDX_EXPANSION_CREDENTIAL_ENV: "QMDX_TEST_ERROR_KEY",
        },
      },
    );
    expect(run.status).toBeGreaterThanOrEqual(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain(SECRET_QUERY);
    expect(run.stderr).not.toContain(SECRET_CREDENTIAL);
  });
});
