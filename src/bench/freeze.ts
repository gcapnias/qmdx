import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import {
  BUILT_IN_ROUTES,
  loadSelectedRawProfile,
} from "../config/resolve.js";
import type { RemoteStage } from "../config/resolve.js";
import {
  EXPANSION_RESPONSE_JSON_SCHEMA,
  EXPANSION_SYSTEM_PROMPT,
} from "../expand/schema.js";
import { HARD_END_TO_END_DEADLINE_MS, MAX_ATTEMPTS_PER_STAGE } from "../core/budgets.js";
import { sha256Hex, stableStringify } from "../preflight/fingerprint.js";
import type { CandidateFreeze, FrozenRoute } from "./types.js";
import { BENCH_SCHEMA_VERSION } from "./types.js";

export const FREEZE_FILE = "freeze.json";

/** Final output depth frozen for every variant; large enough to backfill a canonical top 10. */
export const DEFAULT_OUTPUT_DEPTH = 20;

/**
 * Freezes the production candidate before judgments are revealed: providers,
 * endpoints, models, prompts, schemas, scoring formula, retry policy, output
 * depth, and every outcome-affecting parameter this build pins. The freeze is
 * content-addressed; `run` refuses to execute against a mismatching profile.
 */
export function buildCandidateFreeze(input: {
  benchmarkId: string;
  profileName: string;
  rawProfile: ReturnType<typeof loadSelectedRawProfile>;
  outputDepth?: number;
  nowIso?: string;
}): CandidateFreeze {
  if (input.rawProfile === null) {
    throw new Error(
      `Cannot freeze candidate "${input.profileName}": no such route profile exists in the QMDX configuration.`,
    );
  }
  const routes = (stage: RemoteStage): FrozenRoute => {
    const merged = { ...BUILT_IN_ROUTES[stage], ...(input.rawProfile![stage] ?? {}) };
    return { provider: merged.provider, endpoint: merged.endpoint, model: merged.model };
  };
  const expansion = routes("expansion");
  const reranking = routes("reranking");
  const partial: Omit<CandidateFreeze, "freezeHash"> = {
    schemaVersion: BENCH_SCHEMA_VERSION,
    benchmarkId: input.benchmarkId,
    profileName: input.profileName,
    frozenAt: input.nowIso ?? new Date().toISOString(),
    outputDepth: input.outputDepth ?? DEFAULT_OUTPUT_DEPTH,
    expansion,
    reranking,
    scoring: {
      formula: "qmd-position-aware-v1",
      rankBands: [
        { upToRank: 3, retrievalWeight: 0.75 },
        { upToRank: 10, retrievalWeight: 0.6 },
        { upToRank: Number.MAX_SAFE_INTEGER, retrievalWeight: 0.4 },
      ],
    },
    retryPolicy: {
      maxAttemptsPerStage: MAX_ATTEMPTS_PER_STAGE,
      hardDeadlineMs: HARD_END_TO_END_DEADLINE_MS,
    },
    prompts: {
      expansionSystemPromptSha256: sha256Hex(EXPANSION_SYSTEM_PROMPT),
      expansionResponseSchemaSha256: sha256Hex(stableStringify(EXPANSION_RESPONSE_JSON_SCHEMA)),
    },
  };
  return { ...partial, freezeHash: freezeHash(partial) };
}

/**
 * Recomputes and verifies a stored freeze against the current configuration;
 * tuning after reveal requires a new benchmark version, so any mismatch fails.
 */
export function verifyCandidateFreeze(
  stored: CandidateFreeze,
  input: { benchmarkId: string; profileName: string; rawProfile: ReturnType<typeof loadSelectedRawProfile> },
): void {
  const expected = buildCandidateFreeze({
    benchmarkId: stored.benchmarkId,
    profileName: stored.profileName,
    rawProfile: input.rawProfile,
    outputDepth: stored.outputDepth,
    nowIso: stored.frozenAt,
  });
  const problems: string[] = [];
  if (stored.benchmarkId !== input.benchmarkId) {
    problems.push(`freeze targets benchmark "${stored.benchmarkId}", expected "${input.benchmarkId}".`);
  }
  if (stored.profileName !== input.profileName) {
    problems.push(`freeze records profile "${stored.profileName}", requested "${input.profileName}".`);
  }
  if (expected.freezeHash !== stored.freezeHash) {
    problems.push(
      "the candidate configuration drifted after the freeze; outcome-affecting changes require a new benchmark version.",
    );
  }
  if (problems.length > 0) throw new Error(problems.join(" "));
}

export function freezeHash(freezeWithoutHash: Omit<CandidateFreeze, "freezeHash">): string {
  return createHash("sha256").update(stableStringify(freezeWithoutHash)).digest("hex");
}

export function writeFreezeFile(benchDir: string, freeze: CandidateFreeze): string {
  const path = `${benchDir}/${FREEZE_FILE}`;
  writeFileSync(path, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  return path;
}

export function readFreezeFile(benchDir: string): CandidateFreeze | null {
  try {
    return JSON.parse(readFileSync(`${benchDir}/${FREEZE_FILE}`, "utf8")) as CandidateFreeze;
  } catch {
    return null;
  }
}
