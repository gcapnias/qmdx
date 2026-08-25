import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEmbeddedTestIndex, type TestIndex } from "./helpers/test-index.js";
import {
  buildValidCanonicalization,
  buildValidJudgments,
  buildValidManifest,
  FIXTURE_QUERY_IDS,
} from "./helpers/bench-fixture.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const BENCH_BIN = join(REPO_ROOT, "dist", "bin", "qmdx-bench.js");

let index: TestIndex;
let benchDir: string;
let outputDir: string;

beforeAll(async () => {
  index = await createEmbeddedTestIndex({
    "graph-engineering.md": "# Graph engineering\n\nGraph engineering studies dependency graphs.\n",
    "claude-code.md": "# Claude Code\n\nClaude Code is an interactive CLI coding tool.\n",
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `topic-${i}.md`,
        `# Topic ${i}\n\nUnique subject matter ${i} for retrieval.\n`,
      ]),
    ),
  });
  benchDir = mkdtempSync(join(tmpdir(), "qmdx-bench-data-"));
  outputDir = mkdtempSync(join(tmpdir(), "qmdx-bench-out-"));

  const manifest = buildValidManifest({
    queries: buildValidManifest().queries.map((query) => ({
      ...query,
      text:
        query.id <= "h-02"
          ? "graph engineering"
          : query.id <= "h-06"
            ? "claude code"
            : `topic ${query.id}`,
    })),
  });

  // Freeze the actual corpus snapshot hashes so the harness accepts this index.
  const { createHash } = await import("node:crypto");
  const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  manifest.corpus.indexYamlSha256 = hashFile(index.configPath);
  manifest.corpus.indexSqliteSha256 = hashFile(index.dbPath);

  writeFileSync(join(benchDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(benchDir, "canonicalization.json"),
    `${JSON.stringify(buildValidCanonicalization(), null, 2)}\n`,
  );
  writeFileSync(join(benchDir, "judgments.json"), `${JSON.stringify(buildValidJudgments(), null, 2)}\n`);
}, 120000);

afterAll(() => {
  rmSync(benchDir, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
});

function runBench(args: readonly string[]) {
  return spawnSync(process.execPath, [BENCH_BIN, ...args], {
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      QMD_CONFIG_DIR: mkdtempSync(join(tmpdir(), "qmdx-bench-config-")),
      // Offline vector probes inside the CLI children (same seam as test/helpers).
      NODE_OPTIONS: `--import ${pathToFileURL(join(REPO_ROOT, "test", "helpers", "fake-embed.mjs")).href}`,
      QMDX_TEST_FAKE_EMBED_DIM: "8",
    },
  });
}

describe("qmdx-bench validate", () => {
  it("validates the frozen workload and family assignments", () => {
    const result = runBench(["validate", "--bench", benchDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/20 queries \(20 headline\) across 16 topic families/);
    expect(result.stdout).toMatch(/adjudication frozen/);
  });

  it("fails loudly when frozen data files are missing", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "qmdx-bench-empty-"));
    try {
      const result = runBench(["validate", "--bench", emptyDir]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Missing required benchmark data file/);
      expect(result.stderr).toMatch(/manifest\.json/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("qmdx-bench freeze", () => {
  it("refuses to freeze an unknown profile", () => {
    const result = runBench(["freeze", "--bench", benchDir, "--profile", "does-not-exist"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does-not-exist/);
  });
});

describe("qmdx-bench run (baseline-only controlled evidence)", () => {
  it(
    "drives the public CLI per query and writes a non-authoritative package without a production verdict",
    () => {
      const result = runBench([
        "run",
        "--bench",
        benchDir,
        "--variants",
        "baseline",
        "--mode",
        "controlled",
        "--cwd",
        index.root,
        "--output",
        outputDir,
      ]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const evidence = JSON.parse(readFileSync(join(outputDir, "evidence.json"), "utf8"));
      expect(evidence.authority).toBe("controlled-nonauthoritative");
      expect(evidence.productionOutcome).toBeNull();
      expect(evidence.productionOutcomeNote).toMatch(/human operator/);
      expect(evidence.relevanceGate.evaluation).toBeDefined();
      expect(evidence.candidateFreeze).toBeNull();

      const runs = JSON.parse(readFileSync(join(outputDir, "runs.json"), "utf8")) as Array<{
        variant: string;
        queryId: string;
        argv: string[];
        exitCode: number | null;
        cacheHit: boolean;
      }>;
      expect(runs).toHaveLength(FIXTURE_QUERY_IDS.length);
      for (const run of runs) {
        expect(run.variant).toBe("baseline");
        expect(run.argv[0]).toBe("query");
        expect(run.argv).toContain("--no-expand");
        expect(run.argv).toContain("--no-rerank");
        expect(run.argv).toContain("--format");
        expect(run.exitCode).toBe(0);
        expect(run.cacheHit).toBe(false);
      }
      expect(existsSync(join(outputDir, "evidence.json"))).toBe(true);

      // Robustness/diagnostic slices are outside the primary aggregate but the
      // package records their exclusion diagnostically.
      expect(evidence.relevanceGate.eligibleQueryCount).toBeLessThanOrEqual(20);
    },
    180000,
  );

  it("refuses candidate runs without a freeze document", () => {
    const result = runBench([
      "run",
      "--bench",
      benchDir,
      "--variants",
      "candidate",
      "--profile",
      "any",
      "--cwd",
      index.root,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/freeze\.json|Freeze the candidate/);
  });

  it("refuses to run against an index that does not match the frozen corpus snapshot", () => {
    const otherIndex = mkdtempSync(join(tmpdir(), "qmdx-bench-wrong-index-"));
    try {
      const result = runBench([
        "run",
        "--bench",
        benchDir,
        "--variants",
        "baseline",
        "--cwd",
        otherIndex,
        "--output",
        join(outputDir, "unused"),
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Frozen corpus file is missing|frozen manifest hash/);
    } finally {
      rmSync(otherIndex, { recursive: true, force: true });
    }
  });
});
