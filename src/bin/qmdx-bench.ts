#!/usr/bin/env node
/**
 * qmdx-bench — development-only benchmark harness (issue #3).
 *
 * Drives the public `qmdx` CLI as child processes to capture controlled
 * benchmark evidence. This tool is not part of the public QMDX CLI contract
 * and cannot emit an accepted/rejected/inconclusive production acceptance
 * outcome; that classification requires live acceptance evidence gathered by
 * a human operator.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AliasIndex } from "../bench/canon.js";
import {
  buildCandidateFreeze,
  DEFAULT_OUTPUT_DEPTH,
  FREEZE_FILE,
  readFreezeFile,
  verifyCandidateFreeze,
  writeFreezeFile,
} from "../bench/freeze.js";
import { buildEvidencePackage, writeEvidencePackage } from "../bench/package.js";
import {
  executeRun,
  harnessEnvironment,
  randomizedQueryOrder,
  verifyCorpus,
} from "../bench/runner.js";
import type { BenchVariant, RunAuthority, RunRecord } from "../bench/types.js";
import { loadSelectedRawProfile } from "../config/resolve.js";
import {
  BenchDataError,
  loadAndValidateBenchInputs,
} from "../bench/validate.js";

const USAGE = `Usage: qmdx-bench <command> [options]

Commands:
  validate --bench <dir>
      Validate the frozen manifest, canonicalization map, and judgments.
  freeze   --bench <dir> --profile <name> [--depth <n>]
      Freeze the production candidate before judgments are revealed.
  run      --bench <dir> [--profile <name>] [--output <dir>] [--mode controlled|live]
           [--variants baseline,candidate] [--repeats <n>] [--window <label>] [--cwd <dir>]
      Execute the frozen workload through the public CLI and write the
      evidence package (default mode "controlled": runs are marked
      non-authoritative).

The harness invokes only the public CLI. Controlled or stub-provider runs are
non-authoritative and never produce accepted/rejected/inconclusive verdicts.
`;

interface CommonOptions {
  benchDir: string;
}

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument "${arg}"`);
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i++;
    }
  }
  return options;
}

function requireOption(options: Record<string, string | boolean>, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${key} is required`);
  }
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = argv[0]!;
  const rest = argv.slice(1);

  try {
    switch (command) {
      case "validate":
        return commandValidate(parseArgs(rest));
      case "freeze":
        return await commandFreeze(parseArgs(rest));
      case "run":
        return await commandRun(parseArgs(rest));
      default:
        process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof BenchDataError || error instanceof Error) {
      process.stderr.write(`qmdx-bench: ${error.message}\n`);
    } else {
      process.stderr.write(`qmdx-bench: ${String(error)}\n`);
    }
    return 1;
  }
}

function commandValidate(options: Record<string, string | boolean>): number {
  const benchDir = requireOption(options, "bench");
  const { manifest, judgments } = loadAndValidateBenchInputs(benchDir);
  const headline = manifest.queries.filter((query) => query.slice === "headline").length;
  process.stdout.write(
    [
      `benchmark "${manifest.benchmarkId}" validated`,
      `${manifest.queries.length} queries (${headline} headline) across ${manifest.families.length} topic families`,
      `adjudication frozen at ${judgments.adjudicationFrozenAt}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function commandFreeze(options: Record<string, string | boolean>): Promise<number> {
  const benchDir = requireOption(options, "bench");
  const profileName = requireOption(options, "profile");
  const rawDepth =
    typeof options["depth"] === "string" ? Number(options["depth"]) : DEFAULT_OUTPUT_DEPTH;
  if (!Number.isInteger(rawDepth) || rawDepth < 10 || rawDepth > 80) {
    throw new Error("--depth must be an integer from 10 through 80");
  }
  const { manifest } = loadAndValidateBenchInputs(benchDir);
  const rawProfile = loadSelectedRawProfile(profileName);
  const freeze = buildCandidateFreeze({
    benchmarkId: manifest.benchmarkId,
    profileName,
    rawProfile,
    outputDepth: rawDepth,
  });
  const path = writeFreezeFile(benchDir, freeze);
  process.stdout.write(
    `frozen candidate profile "${profileName}" -> ${path}\n` +
      "providers, endpoints, models, prompts, schemas, scoring, retries, policies are now outcome-affecting parameters.\n",
  );
  return 0;
}

async function commandRun(options: Record<string, string | boolean>): Promise<number> {
  const benchDir = requireOption(options, "bench");
  const outputDir =
    typeof options["output"] === "string" ? (options["output"] as string) : join(benchDir, "evidence");
  const cwd = typeof options["cwd"] === "string" ? (options["cwd"] as string) : process.cwd();
  const mode = typeof options["mode"] === "string" ? (options["mode"] as string) : "controlled";
  if (mode !== "controlled" && mode !== "live") {
    throw new Error('--mode expects "controlled" or "live"');
  }
  const variants = (typeof options["variants"] === "string"
    ? (options["variants"] as string)
    : "baseline,candidate"
  ).split(",") as BenchVariant[];
  for (const variant of variants) {
    if (variant !== "baseline" && variant !== "candidate") {
      throw new Error(`--variants accepts only baseline,candidate (found "${variant}")`);
    }
  }
  const repeats = typeof options["repeats"] === "string" ? Number(options["repeats"]) : 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) {
    throw new Error("--repeats must be an integer from 1 through 3");
  }
  const windowLabel = typeof options["window"] === "string" ? (options["window"] as string) : "window-1";

  const { manifest, canonicalization, judgments } = loadAndValidateBenchInputs(benchDir);
  const aliases = new AliasIndex(canonicalization);

  const profileName =
    typeof options["profile"] === "string" ? (options["profile"] as string) : null;
  if (variants.includes("candidate") && profileName === null) {
    throw new Error("--profile is required for candidate runs");
  }
  const freeze = readFreezeFile(benchDir);
  if (freeze !== null && profileName !== null) {
    verifyCandidateFreeze(freeze, {
      benchmarkId: manifest.benchmarkId,
      profileName,
      rawProfile: loadSelectedRawProfile(profileName),
    });
  } else if (freeze === null && variants.includes("candidate")) {
    throw new Error(
      `Missing ${join(benchDir, FREEZE_FILE)}. Freeze the candidate with "qmdx-bench freeze" before running it; tuning after judgments are revealed requires a new benchmark version.`,
    );
  }

  // The corpus snapshot is frozen by the manifest; refuse any other index.
  const indexPath = join(cwd, ".qmd", "index.yaml");
  const dbPath = join(cwd, ".qmd", "index.sqlite");
  await verifyCorpus({
    indexPath,
    dbPath,
    expectedYamlSha256: manifest.corpus.indexYamlSha256,
    expectedSqliteSha256: manifest.corpus.indexSqliteSha256,
  });

  const authority: RunAuthority =
    mode === "controlled" ? "controlled-nonauthoritative" : "live-candidate-package";

  const environment = harnessEnvironment();
  const notes: string[] = [];
  if (authority === "controlled-nonauthoritative") {
    notes.push(
      "controlled-mode evidence (stub/controlled provider substitutes permitted); non-authoritative and incapable of a production acceptance classification.",
    );
  }
  if (repeats < 3) {
    notes.push(
      "operational latency/reliability gates require three uncached runs per headline query repeated in two time windows on the named target workstation; this package does not satisfy that protocol.",
    );
  }

  const workload = manifest.queries.filter((query) => query.slice !== "diagnostic");
  const runs: RunRecord[] = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
    const order = randomizedQueryOrder(workload, manifest.seed + repeatIndex);
    for (const query of order) {
      for (const variant of variants) {
        process.stdout.write(`[${variant}] ${query.id}: `);
        const record = await executeRun({
          variant,
          query,
          outputDepth: freeze?.outputDepth ?? DEFAULT_OUTPUT_DEPTH,
          profileName,
          cwd,
          window: windowLabel,
          repeatIndex,
        });
        runs.push(record);
        process.stdout.write(
          record.exitCode === 0 ? `ok (${record.wallMs}ms)\n` : `exit ${record.exitCode}\n`,
        );
      }
    }
  }

  const pkg = buildEvidencePackage({
    manifest,
    judgments,
    aliases,
    runs,
    freeze,
    authority,
    environment,
    notes,
  });
  mkdirSync(outputDir, { recursive: true });
  writeEvidencePackage(outputDir, pkg, runs);
  process.stdout.write(
    [
      "",
      `evidence package written to ${join(outputDir, "evidence.json")}`,
      `authority: ${pkg.authority}`,
      `production acceptance outcome: NOT ISSUED (${pkg.productionOutcomeNote})`,
      `gate evaluation: ${pkg.relevanceGate.evaluation}`,
      pkg.relevanceGate.gateFailReasons.length > 0
        ? `gate failures: ${pkg.relevanceGate.gateFailReasons.join("; ")}`
        : "gate failures: none",
    ].join("\n"),
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`qmdx-bench: ${String(error)}\n`);
    process.exitCode = 5;
  });
