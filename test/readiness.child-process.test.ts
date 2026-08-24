import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import {
  addToTestIndex,
  createEmbeddedTestIndex,
  createTestIndex,
  REQUIRED_EMBED_MODEL,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import type { ErrorEnvelope } from "../src/core/envelope.js";
import type { ReadinessDiagnostics } from "../src/cli/readiness-command.js";

const OVERRIDE_EMBED_MODEL = "hf:example-org/other-embed/other-embed-q8_0.gguf";

function doc(name: string, topic: string): [string, string] {
  return [
    `${name}.md`,
    `# ${name}\n\nNotes about ${topic} for the readiness corpus.\n`,
  ];
}

function docs(count: number): Record<string, string> {
  const topics = [
    "vector embeddings",
    "lexical ranking",
    "multilingual retrieval",
    "sqlite storage",
    "search latency",
    "reranking quality",
    "greek vocabulary",
    "english prose",
    "index maintenance",
    "coverage thresholds",
  ];
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => doc(`doc${i + 1}`, topics[i % topics.length]!)),
  );
}

let healthy: TestIndex;
let empty: TestIndex;
let vectorless: TestIndex;
let materiallyIncomplete: TestIndex;
let partiallyEmbedded: TestIndex;
let overriddenProfile: TestIndex;
let corrupted: TestIndex;

function doctor(index: TestIndex, options?: Parameters<typeof runCli>[2]) {
  return runCli(["doctor", "--format", "json"], index.root, options);
}

function expectErrorEnvelope(stderr: string): ErrorEnvelope {
  return JSON.parse(stderr) as ErrorEnvelope;
}

beforeAll(async () => {
  healthy = await createEmbeddedTestIndex(docs(3));
  empty = await createTestIndex({});
  vectorless = await createTestIndex(docs(2));
  overriddenProfile = await createEmbeddedTestIndex(docs(3), {
    embedModel: OVERRIDE_EMBED_MODEL,
  });
  corrupted = await createTestIndex(docs(1));

  materiallyIncomplete = await createEmbeddedTestIndex(docs(8));
  await addToTestIndex(materiallyIncomplete, {
    "late1.md": "# Late 1\n\nAdded after embedding, never embedded.\n",
    "late2.md": "# Late 2\n\nAdded after embedding, never embedded.\n",
  });

  partiallyEmbedded = await createEmbeddedTestIndex(docs(9));
  await addToTestIndex(partiallyEmbedded, {
    "edge.md": "# Edge\n\nExactly ten percent coverage incomplete.\n",
  });
}, 240000);

afterAll(() => {
  void healthy;
  void empty;
  void vectorless;
  void materiallyIncomplete;
  void partiallyEmbedded;
  void overriddenProfile;
  void corrupted;
});

describe("doctor on a usable index", () => {
  it("reports an ok diagnostics document at exit 0 with empty stderr", () => {
    const run = doctor(healthy, { fakeEmbedDimension: 8 });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");

    const report = JSON.parse(run.stdout) as ReadinessDiagnostics;
    expect(report.schemaVersion).toBe(1);
    expect(report.command).toBe("doctor");
    expect(report.status).toBe("ok");
    expect(report.index).toEqual({
      embedModel: REQUIRED_EMBED_MODEL,
      multilingualProfile: true,
      totalDocuments: 3,
      needsEmbedding: 0,
      incompletePercent: 0,
      hasVectorIndex: true,
      vectorProbeResults: 1,
      daysStale: expect.any(Number),
    });
    expect(report.warnings).toEqual([]);
    expect(report.timingMs.total).toBeGreaterThanOrEqual(0);
  });

  it("keeps staleness diagnostic in the report without gating usability", () => {
    const report = JSON.parse(doctor(healthy, { fakeEmbedDimension: 8 }).stdout) as ReadinessDiagnostics;
    expect(report.index.daysStale).toBeGreaterThanOrEqual(0);
  });

  it("prints a human usability summary with probe result", () => {
    const run = runCli(["doctor"], healthy.root, { fakeEmbedDimension: 8 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("qmdx doctor");
    expect(run.stdout).toContain("Embedding profile:");
    expect(run.stdout).toContain(REQUIRED_EMBED_MODEL);
    expect(run.stdout).toContain("Vector readiness probe: ok");
    expect(run.stdout).toContain("Local index is usable.");
  });
});

describe("doctor failure gates", () => {
  it("fails with local_index_incomplete when there are no active documents", () => {
    const run = doctor(empty);
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    const envelope = expectErrorEnvelope(run.stderr);
    expect(envelope.error).toMatchObject({
      category: "local_retrieval",
      code: "local_index_incomplete",
      stage: null,
    });
    expect(envelope.error.message).toContain("no active documents");
  });

  it("fails with local_index_incomplete when the vector index is absent", () => {
    const run = doctor(vectorless);
    expect(run.status).toBe(3);
    const envelope = expectErrorEnvelope(run.stderr);
    expect(envelope.error.code).toBe("local_index_incomplete");
    expect(envelope.error.message).toContain("no vector index");
  });

  it("fails with local_index_unavailable when the store cannot open", () => {
    writeFileSync(corrupted.dbPath, "this is definitely not a sqlite database");
    const run = doctor(corrupted);
    expect(run.status).toBe(3);
    const envelope = expectErrorEnvelope(run.stderr);
    expect(envelope.error).toMatchObject({
      category: "local_retrieval",
      code: "local_index_unavailable",
    });
    expect(envelope.error.message).toContain("Cannot open QMD index");
  });

  it("fails when more than 10% of documents need embedding, naming count and percentage", () => {
    const run = doctor(materiallyIncomplete);
    expect(run.status).toBe(3);
    const envelope = expectErrorEnvelope(run.stderr);
    expect(envelope.error.code).toBe("local_index_incomplete");
    expect(envelope.error.message).toContain("2 of 10");
    expect(envelope.error.message).toContain("20%");
  });

  it("fails with vector_probe_failed when the probe cannot execute against stored vectors", () => {
    const run = doctor(healthy, { fakeEmbedDimension: 4 });
    expect(run.status).toBe(3);
    const envelope = expectErrorEnvelope(run.stderr);
    expect(envelope.error).toMatchObject({
      category: "local_retrieval",
      code: "vector_probe_failed",
      stage: null,
    });
    expect(envelope.error.message).toContain("Vector readiness probe failed");
  });

  it("writes human-readable failures to stderr without envelopes", () => {
    const run = runCli(["doctor"], empty.root);
    expect(run.status).toBe(3);
    expect(run.stderr.startsWith("qmdx:")).toBe(true);
    expect(() => JSON.parse(run.stderr)).toThrow();
  });
});

describe("doctor warnings", () => {
  it("warns with count and percentage at exactly 10% incomplete coverage", () => {
    const run = doctor(partiallyEmbedded, { fakeEmbedDimension: 8 });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");

    const report = JSON.parse(run.stdout) as ReadinessDiagnostics;
    expect(report.status).toBe("ok");
    expect(report.index.needsEmbedding).toBe(1);
    expect(report.index.totalDocuments).toBe(10);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      code: "embedding_coverage_incomplete",
    });
    expect(report.warnings[0]!.message).toContain("1 of 10");
    expect(report.warnings[0]!.message).toContain("10%");
  });

  it("warns that a profile override forfeits the multilingual guarantee and requires a rebuild", () => {
    const run = doctor(overriddenProfile, { fakeEmbedDimension: 8 });
    expect(run.status).toBe(0);

    const report = JSON.parse(run.stdout) as ReadinessDiagnostics;
    expect(report.index.embedModel).toBe(OVERRIDE_EMBED_MODEL);
    expect(report.index.multilingualProfile).toBe(false);
    const overrideWarning = report.warnings.find(
      (warning) => warning.code === "embed_profile_override",
    );
    expect(overrideWarning).toBeDefined();
    expect(overrideWarning!.message).toContain("multilingual");
    expect(overrideWarning!.message).toContain("qmd embed -f");
  });

  it("surfaces coverage warnings on stderr in human mode", () => {
    const run = runCli(["doctor"], partiallyEmbedded.root, {
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Warning:");
    expect(run.stderr).toContain("1 of 10");
  });
});

describe("setup shares the doctor readiness gate", () => {
  it("reports ok diagnostics for the setup command on a usable index", () => {
    const run = runCli(["setup", "--format", "json"], healthy.root, {
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as ReadinessDiagnostics;
    expect(report.command).toBe("setup");
    expect(report.status).toBe("ok");
  });

  it("fails setup with exit 3 on an unusable index", () => {
    const run = runCli(["setup", "--format", "json"], empty.root);
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stderr).error.code).toBe("local_index_incomplete");
  });

  it("accepts --profile, failing on unconfigured names as invalid_profile", () => {
    const run = runCli(["setup", "--profile", "default", "--format", "json"], healthy.root);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("invalid_profile");

    const doctorRun = runCli(["doctor", "--all", "--format", "json"], healthy.root);
    expect(doctorRun.status).toBe(2);
    expect(JSON.parse(doctorRun.stderr).error.code).toBe("unsupported_option");
  });
});

describe("bin dispatch", () => {
  it("rejects unknown commands with usage guidance", () => {
    const run = runCli(["frobnicate"], healthy.root);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown command "frobnicate"');
    expect(run.stderr).toContain("Usage: qmdx <command>");
  });
});
