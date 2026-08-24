import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
};

let index: TestIndex;

beforeAll(async () => {
  index = await createTestIndex(DOCS);
}, 240000);

afterAll(() => {
  void index;
});

function jsonRun(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return runCli([...args, "--format", "json"], index.root);
}

describe("supported options: limits stay output-only", () => {
  it("accepts the full approved range including both boundaries", () => {
    for (const limit of ["1", "10", "80"]) {
      const run = jsonRun(["query", "vector", "-n", limit]);
      expect(run.status).toBe(0);
      const envelope = JSON.parse(run.stdout) as ResultEnvelope;
      expect(envelope.results.length).toBeLessThanOrEqual(Number(limit));
    }
  });

  it("truncates only the final output while candidate depth stays internal", () => {
    const limited = JSON.parse(
      jsonRun(["query", "vector", "-n", "1"]).stdout,
    ) as ResultEnvelope;
    expect(limited.results).toHaveLength(1);
    expect(limited.pipeline.retrieval.candidateCount).toBeGreaterThan(1);
  });
});

describe("supported options: intent", () => {
  it("reflects --intent in the envelope and completes successfully", () => {
    const run = jsonRun(["query", "vector", "--intent", "ranking internals"]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.query.intent).toBe("ranking internals");
    expect(envelope.results.length).toBeGreaterThan(0);
  });
});

describe("supported options: path and line-number presentation", () => {
  it("--full-path shows QMD display paths instead of qmd:// URIs", () => {
    const run = runCli(["query", "embeddings", "--full-path"], index.root);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("qmd://");
    expect(run.stdout).toContain("docs/alpha.md");
  });

  it("default human output keeps qmd:// URIs", () => {
    const run = runCli(["query", "embeddings"], index.root);
    expect(run.stdout).toContain("qmd://docs/alpha.md");
  });

  it("--line-numbers numbers snippet lines from the chunk position", () => {
    const baseline = JSON.parse(
      jsonRun(["query", "embeddings"]).stdout,
    ) as ResultEnvelope;
    const top = baseline.results[0]!;
    expect(top.line).not.toBeNull();

    const run = runCli(["query", "embeddings", "--line-numbers"], index.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${(top.line ?? -1) + 1}: `);
  });

  it("--line-numbers with --full numbers the body from line 1", () => {
    const run = runCli(
      ["query", "embeddings", "--full", "--line-numbers"],
      index.root,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/(^|\n)  1: /);
  });

  it("--full prints the complete body in human output too", () => {
    const run = runCli(["query", "embeddings", "--full"], index.root);
    expect(run.stdout).toContain("Vector embeddings power semantic search");
  });

  it("presentation flags leave JSON envelope fields untouched", () => {
    const run = jsonRun([
      "query",
      "embeddings",
      "--full-path",
      "--line-numbers",
    ]);
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.results[0]!.file).toBe("qmd://docs/alpha.md");
    expect(envelope.results[0]!.snippet).not.toMatch(/: /);
  });
});

describe("typed query documents", () => {
  it("runs an explicit lex route with --no-expand through QMD structured search", () => {
    const run = jsonRun(["query", "lex: embeddings", "--no-expand"]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.query.original).toBe("lex: embeddings");
    expect(envelope.pipeline.expansion.status).toBe("disabled");
    expect(envelope.pipeline.retrieval.candidateCount).toBeGreaterThan(0);
    expect(envelope.results.length).toBeGreaterThan(0);
  });

  it("preserves explicit multi-route documents verbatim", () => {
    const document = "lex: embeddings\nvec: semantic search\nhyde: notes about vectors";
    const run = jsonRun(["query", document, "--no-expand"]);
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.query.original).toBe(document);
    expect(envelope.pipeline.retrieval.candidateCount).toBeGreaterThan(0);
    expect(envelope.results.length).toBeGreaterThan(0);
  });

  it("rejects a document without a plain query unless --no-expand is given", () => {
    const run = jsonRun(["query", "lex: embeddings"]);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error).toMatchObject({
      category: "invocation",
      code: "invalid_invocation",
      stage: null,
    });
  });

  it("rejects expand: because local expansion is outside the compatible perimeter", () => {
    const run = jsonRun(["query", "expand: embeddings"]);
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("unsupported_option");
  });

  it("honors an intent: line from the document", () => {
    const run = jsonRun([
      "query",
      "lex: embeddings\nintent: ranking behavior",
      "--no-expand",
    ]);
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.query.intent).toBe("ranking behavior");
  });

  it("lets the --intent flag take precedence over a document intent line", () => {
    const run = jsonRun([
      "query",
      "lex: embeddings\nintent: document intent",
      "--intent",
      "flag intent",
      "--no-expand",
    ]);
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.query.intent).toBe("flag intent");
  });

  it("rejects an intent: line appearing alone", () => {
    const run = jsonRun(["query", "intent: ranking", "--no-expand"]);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");
  });

  it("rejects mixed plain and typed lines like QMD does", () => {
    const run = jsonRun(["query", "lex: embeddings\nplain text", "--no-expand"]);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");
  });

  it("rejects lex routes with an unmatched double quote", () => {
    const run = jsonRun(["query", 'lex: "embeddings', "--no-expand"]);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");
  });

  it("rejects negation syntax in vec and hyde routes", () => {
    for (const document of ["vec: -term", "hyde: -term"]) {
      const run = jsonRun(["query", document, "--no-expand"]);
      expect(run.status).toBe(2);
      expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");
    }
  });

  it("enforces the 2048-character expansion-input limit on plain queries only", () => {
    const oversizedPlain = "x".repeat(2049);
    const run = jsonRun(["query", oversizedPlain]);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");

    const oversizedTyped = `lex: ${"x".repeat(3000)}`;
    const ok = jsonRun(["query", oversizedTyped, "--no-expand", "-c", "docs"]);
    expect(ok.status).toBe(0);
  });

  it("keeps min-score filtering working against explicit typed routes", () => {
    const run = jsonRun([
      "query",
      "lex: embeddings",
      "--no-expand",
      "--min-score",
      "0.99",
    ]);
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    for (const result of envelope.results) {
      expect(result.score).toBeGreaterThanOrEqual(0.99);
    }
    expect(envelope.results.every((result) => result.score >= 1)).toBe(true);
  });
});

describe("rejected QMD surface", () => {
  const REJECTED_OPTIONS: ReadonlyArray<readonly string[]> = [
    ["--all"],
    ["--candidate-limit"],
    ["--candidate-limit", "40"],
    ["-C", "40"],
    ["--chunk-strategy", "auto"],
    ["--no-gpu"],
    ["--no-line-numbers"],
    ["--json"],
    ["--csv"],
    ["--md"],
    ["--xml"],
    ["--files"],
    ["--index", "other"],
    ["--bogus"],
  ];

  for (const option of REJECTED_OPTIONS) {
    it(`reports ${option.join(" ")} as unsupported_option instead of ignoring it`, () => {
      const run = jsonRun(["query", "vector", ...option]);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.error).toMatchObject({
        category: "invocation",
        code: "unsupported_option",
        stage: null,
        retryable: false,
      });
      expect(typeof envelope.timingMs.total).toBe("number");
    });
  }

  it("names the offending option in the error message", () => {
    const run = runCli(["query", "vector", "--all"], index.root);
    expect(run.stderr).toContain("--all");
  });

  it("rejects out-of-range limits and non-numeric scores as invalid invocation", () => {
    for (const args of [["-n", "81"], ["-n", "0"], ["--min-score", "1.5"], ["--min-score", "abc"]]) {
      const run = jsonRun(["query", "vector", ...args]);
      expect(run.status).toBe(2);
      expect(JSON.parse(run.stderr).error.code).toBe("invalid_invocation");
    }
  });
});
