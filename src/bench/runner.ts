import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResultEnvelope } from "../core/envelope.js";
import type {
  BenchQuery,
  BenchVariant,
  RunRecord,
} from "./types.js";

const REQUIRE = createRequire(import.meta.url);

export interface HarnessEnvironment {
  qmdxVersion: string;
  qmdVersion: string;
  nodeVersion: string;
  platform: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  binPath: string;
}

export function harnessEnvironment(): HarnessEnvironment {
  const rootPackage = REQUIRE("../../package.json") as { version: string };
  const os = REQUIRE("node:os") as typeof import("node:os");
  let qmdVersion = "unknown";
  try {
    const qmdPackage = REQUIRE("@tobilu/qmd/package.json") as { version: string };
    qmdVersion = qmdPackage.version;
  } catch {
    qmdVersion = "unknown";
  }
  return {
    qmdxVersion: rootPackage.version,
    qmdVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    binPath: fileURLToPath(new URL("../../dist/bin/qmdx.js", import.meta.url)),
  };
}

/**
 * SHA-256 of a file, streamed so large index snapshots stay cheap.
 */
export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verifies the live corpus snapshot against the manifest's frozen hashes.
 * Running against any other index silently invalidates every comparison.
 */
export async function verifyCorpus(input: {
  indexPath: string;
  dbPath: string;
  expectedYamlSha256: string;
  expectedSqliteSha256: string;
}): Promise<void> {
  for (const path of [input.indexPath, input.dbPath]) {
    if (!existsSync(path)) {
      throw new Error(`Frozen corpus file is missing: ${path}`);
    }
  }
  const yamlHash = await sha256File(input.indexPath);
  if (yamlHash !== input.expectedYamlSha256) {
    throw new Error(
      `Index configuration hash ${yamlHash} does not match the frozen manifest hash ${input.expectedYamlSha256}; refusing to run against a different corpus snapshot.`,
    );
  }
  const sqliteHash = await sha256File(input.dbPath);
  if (sqliteHash !== input.expectedSqliteSha256) {
    throw new Error(
      `Index database hash ${sqliteHash} does not match the frozen manifest hash ${input.expectedSqliteSha256}; refusing to run against a different corpus snapshot.`,
    );
  }
}

/** Deterministic order for one repeat pass over the workload. */
export function randomizedQueryOrder(queries: readonly BenchQuery[], seed: number): BenchQuery[] {
  const order = [...queries];
  let state = seed >>> 0;
  for (let i = order.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

/**
 * Exact public-CLI invocations per variant. The baseline uses the same index,
 * local retrieval, fusion, candidate depth, and output limit with expansion
 * and reranking disabled (`--no-expand --no-rerank`); the candidate drives its
 * frozen profile through the ordinary `query` command. Nothing else is ever
 * invoked — no internal APIs, no direct store access.
 */
export function cliArgsFor(input: {
  variant: BenchVariant;
  queryText: string;
  outputDepth: number;
  profileName: string | null;
}): string[] {
  const shared = [
    "query",
    input.queryText,
    "--format",
    "json",
    "--explain",
    "-n",
    String(input.outputDepth),
  ];
  if (input.variant === "baseline") {
    return [...shared, "--no-expand", "--no-rerank"];
  }
  if (input.profileName === null) {
    throw new Error("Candidate runs require --profile.");
  }
  return [...shared, "--profile", input.profileName];
}

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnCli(binPath: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

/**
 * Executes one benchmark invocation of the public CLI and records the full
 * run record: exact argv, envelope(s), wall time, and cache state. Runs where
 * a remote stage reports a persistent-cache hit are flagged; acceptance
 * measurements are uncached, and cache hits must never be used to pass.
 */
export async function executeRun(input: {
  binPath?: string;
  variant: BenchVariant;
  query: BenchQuery;
  outputDepth: number;
  profileName: string | null;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  window: string;
  repeatIndex: number;
}): Promise<RunRecord> {
  const binPath = input.binPath ?? harnessEnvironment().binPath;
  const argv = cliArgsFor({
    variant: input.variant,
    queryText: input.query.text,
    outputDepth: input.outputDepth,
    profileName: input.profileName,
  });
  const startedAt = Date.now();
  const result = await spawnCli(binPath, argv, input.cwd, input.env ?? process.env);
  const wallMs = Date.now() - startedAt;

  const record: RunRecord = {
    variant: input.variant,
    queryId: input.query.id,
    argv,
    exitCode: result.status,
    wallMs,
    window: input.window,
    repeatIndex: input.repeatIndex,
    stdout: result.stdout,
    stderr: result.stderr,
    cacheHit: false,
    cacheStates: { expansion: "absent", reranking: "absent" },
  };

  const parsed = parseJsonLine(result.stdout) ?? parseJsonLine(result.stderr);
  if (parsed !== null && typeof parsed === "object" && parsed !== null) {
    if ("pipeline" in parsed) {
      record.resultEnvelope = parsed;
      const pipeline = (parsed as ResultEnvelope).pipeline;
      record.cacheStates = {
        expansion: pipeline.expansion.metadata.cache ?? "absent",
        reranking: pipeline.reranking.metadata.cache ?? "absent",
      };
      record.cacheHit =
        pipeline.expansion.metadata.cache === "hit" || pipeline.reranking.metadata.cache === "hit";
    } else if ("error" in parsed) {
      record.errorEnvelope = parsed;
    }
  }
  return record;
}

/**
 * Cache-hit filter (#13 notes): exclude runs where either remote stage was
 * served from the persistent cache; acceptance measurements are uncached.
 */
export function isCacheContaminated(record: RunRecord): boolean {
  return record.cacheHit;
}

function parseJsonLine(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
