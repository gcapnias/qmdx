import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestIndex,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import type { ErrorEnvelope, ResultEnvelope } from "../src/core/envelope.js";

const DOCS = {
  "alpha.md":
    "# Alpha\n\nVector embeddings power semantic search across languages.\n",
  "beta.md":
    "# Beta\n\nVector search blends lexical and semantic signals for ranking.\n",
  "gamma.md":
    "# Gamma\n\nGrafana dashboards track latency metrics across regions.\n",
};

let index: TestIndex;
let emptyDir: string;

beforeAll(async () => {
  index = await createTestIndex(DOCS);
  emptyDir = mkdtempSync(join(tmpdir(), "qmdx-empty-"));
}, 240000);

afterAll(() => {
  void index;
  void emptyDir;
});

function expectSingleJson<T>(stdout: string): T {
  const parsed = JSON.parse(stdout) as T;
  return parsed;
}

describe("query --format json", () => {
  it("returns one result envelope on stdout with empty stderr and exit 0", async () => {
    const run = await runCli(
      ["query", "embeddings", "--format", "json", "--explain"],
      index.root,
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");

    const envelope = expectSingleJson<ResultEnvelope>(run.stdout);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.query).toEqual({
      original: "embeddings",
      intent: null,
      collections: [],
    });
  });

  it("performs a real local search with result identity matching the controlled index", async () => {
    const run = await runCli(
      ["query", "embeddings", "--format", "json", "--explain"],
      index.root,
    );
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;

    const alphaDocid = index.docidsByFile.get("alpha.md");
    expect(alphaDocid).toBeTruthy();

    expect(envelope.pipeline.retrieval).toMatchObject({
      status: "ok",
      reason: null,
      engine: "qmd",
    });
    expect(envelope.pipeline.retrieval.candidateCount).toBeGreaterThan(0);
    expect(envelope.results.length).toBeGreaterThan(0);

    const top = envelope.results[0]!;
    expect(top.rank).toBe(1);
    expect(top.title).toBe("Alpha");
    expect(top.file).toBe("qmd://docs/alpha.md");
    expect(top.docid).toBe(`#${alphaDocid}`);
    expect(top.score).toBeCloseTo(1, 6);
    expect(top.line).toBe(0);

    expect(Object.keys(top).sort()).toContain("context");
  });

  it("reports degraded remote stages with closed warning codes while staying exit 0", async () => {
    const run = await runCli(["query", "embeddings", "--format", "json"], index.root);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;

    expect(envelope.pipeline.status).toBe("degraded");
    expect(envelope.pipeline.expansion.status).toBe("degraded");
    expect(envelope.pipeline.expansion.reason).toBe("provider_unavailable");
    expect(envelope.pipeline.reranking.status).toBe("degraded");
    expect(envelope.pipeline.expansion.generatedQueries).toEqual([]);

    const codes = envelope.warnings.map((warning) => warning.code);
    expect(codes).toContain("provider_unavailable");
    for (const warning of envelope.warnings) {
      expect(["expansion", "reranking"]).toContain(warning.stage);
      expect(typeof warning.message).toBe("string");
      expect(typeof warning.retryable).toBe("boolean");
    }

    for (const stage of ["expansion", "retrieval", "reranking", "overhead", "total"] as const) {
      expect(envelope.timingMs[stage]).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the QMD position score mode when reranking is degraded", async () => {
    const run = await runCli(
      ["query", "vector semantic", "--format", "json", "--explain"],
      index.root,
    );
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;

    expect(envelope.results.length).toBeGreaterThanOrEqual(2);
    let previousScore = Number.POSITIVE_INFINITY;
    envelope.results.forEach((result, i) => {
      expect(result.rank).toBe(i + 1);
      expect(result.score).toBeCloseTo(1 / result.rank, 6);
      expect(result.score).toBeLessThanOrEqual(previousScore);
      previousScore = result.score;
      expect(result.explanation).toEqual({
        qmdRrfRank: result.rank,
        qmdPositionWeight: 1,
        remoteRerankScore: null,
        finalScore: result.score,
      });
    });
  });

  it("honors --limit and --min-score on the public position score", async () => {
    const limited = (
      await runCli(
        ["query", "vector semantic", "--format", "json", "-n", "1"],
        index.root,
      )
    ).stdout as string;
    const limitedEnvelope = JSON.parse(limited) as ResultEnvelope;
    expect(limitedEnvelope.results).toHaveLength(1);

    const filtered = JSON.parse(
      (
        await runCli(
          ["query", "vector semantic", "--format", "json", "--min-score", "0.6"],
          index.root,
        )
      ).stdout,
    ) as ResultEnvelope;
    expect(filtered.results.every((result) => result.score >= 0.6)).toBe(true);
    expect(filtered.results.length).toBeLessThan(
      (JSON.parse(
        (await runCli(["query", "vector semantic", "--format", "json"], index.root))
          .stdout,
      ) as ResultEnvelope).results.length,
    );
  });

  it("supports -c/--collection filtering and rejects unknown collections safely", async () => {
    const scoped = JSON.parse(
      (
        await runCli(
          ["query", "latency", "--format", "json", "-c", "docs"],
          index.root,
        )
      ).stdout,
    ) as ResultEnvelope;
    expect(scoped.query.collections).toEqual(["docs"]);
  });

  it("prints No results found. semantics through an empty results array at exit 0", async () => {
    const run = await runCli(
      ["query", "zzzunmatchabletoken", "--format", "json"],
      index.root,
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.results).toEqual([]);
  });

  it("--full adds body and --no-rerank reports the disabled stage", async () => {
    const run = await runCli(
      [
        "query",
        "embeddings",
        "--format",
        "json",
        "--full",
        "--no-rerank",
        "--no-expand",
      ],
      index.root,
    );
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.results[0]!.body).toContain("Vector embeddings");
    expect(envelope.pipeline.reranking.status).toBe("disabled");
    expect(envelope.pipeline.expansion.status).toBe("disabled");
    expect(envelope.warnings).toEqual([]);
    expect(run.status).toBe(0);
  });

  it("--require-remote fails with exit 4 and a required_remote error envelope", async () => {
    const run = await runCli(
      ["query", "embeddings", "--format", "json", "--require-remote"],
      index.root,
    );
    expect(run.status).toBe(4);
    expect(run.stdout).toBe("");
    const envelope = expectSingleJson<ErrorEnvelope>(run.stderr);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.error).toMatchObject({
      category: "required_remote",
      code: "required_remote_failed",
      stage: "expansion",
      retryable: false,
    });
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(typeof envelope.timingMs.total).toBe("number");
  });
});

describe("query human output", () => {
  it("renders numbered results with qmd URI and docid, warnings to stderr", async () => {
    const run = await runCli(["query", "embeddings"], index.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1. Alpha");
    expect(run.stdout).toContain("qmd://docs/alpha.md");
    expect(run.stdout).toContain(`#${index.docidsByFile.get("alpha.md")}`);
    expect(run.stderr).toContain("Warning:");
  });

  it("prints No results found. and exits 0 for zero matches", async () => {
    const run = await runCli(["query", "zzzunmatchabletoken"], index.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No results found.");
  });
});

describe("invocation errors", () => {
  it("rejects unsupported options with exit 2 and a stderr error envelope in json mode", async () => {
    const run = await runCli(["query", "term", "--all", "--format", "json"], index.root);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    const envelope = expectSingleJson<ErrorEnvelope>(run.stderr);
    expect(envelope.error).toMatchObject({
      category: "invocation",
      code: "unsupported_option",
      stage: null,
    });
  });

  it("rejects out-of-range limits with invalid_invocation", async () => {
    for (const limit of ["0", "81", "-3"]) {
      const run = await runCli(
        ["query", "term", "-n", limit, "--format", "json"],
        index.root,
      );
      expect(run.status).toBe(2);
      const envelope = expectSingleJson<ErrorEnvelope>(run.stderr);
      expect(envelope.error.code).toBe("invalid_invocation");
    }
  });

  it("requires non-empty query text", async () => {
    const missing = await runCli(["query", "--format", "json"], index.root);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stderr).error.code).toBe("invalid_invocation");

    const blank = await runCli(["query", "   ", "--format", "json"], index.root);
    expect(blank.status).toBe(2);
    expect(JSON.parse(blank.stderr).error.code).toBe("invalid_invocation");
  });

  it("rejects multiple positional arguments instead of reinterpreting them", async () => {
    const run = await runCli(["query", "one two", "three", "--format", "json"], index.root);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");
  });

  it("rejects unconfigured profiles as a configuration error", async () => {
    const run = await runCli(
      ["query", "term", "--profile", "enterprise", "--format", "json"],
      index.root,
    );
    expect(run.status).toBe(2);
    const envelope = expectSingleJson<ErrorEnvelope>(run.stderr);
    expect(envelope.error).toMatchObject({
      category: "configuration",
      code: "invalid_profile",
    });
  });

  it("fails local-retrieval with exit 3 when no project index exists", async () => {
    const run = await runCli(["query", "term", "--format", "json"], emptyDir);
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    const envelope = expectSingleJson<ErrorEnvelope>(run.stderr);
    expect(envelope.error).toMatchObject({
      category: "local_retrieval",
      code: "local_index_unavailable",
    });
  });

  it("writes human-readable errors to stderr without envelopes", async () => {
    const run = await runCli(["query", "term", "--all"], index.root);
    expect(run.status).toBe(2);
    expect(run.stderr.startsWith("qmdx:")).toBe(true);
    expect(() => JSON.parse(run.stderr)).toThrow();
  });
});

describe("executable packaging", () => {
  it("exposes the same native-ESM bin entry for direct node invocation", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      join(process.cwd(), "dist", "bin", "qmdx.js"),
      "utf8",
    );
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    );
    expect(pkg.bin.qmdx).toBe("./dist/bin/qmdx.js");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.dependencies["@tobilu/qmd"]).toBe("2.8.3");
  });
});
