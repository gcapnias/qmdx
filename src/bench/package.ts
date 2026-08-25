import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultEnvelope } from "../core/envelope.js";
import type { AliasIndex } from "./canon.js";
import { canonicalRanking, ndcgAt10 } from "./canon.js";
import { rankingDiagnostics } from "./metrics.js";
import {
  evaluateOperationalGates,
  evaluateRelevanceGate,
} from "./metrics.js";
import type { HarnessEnvironment } from "./runner.js";
import { isCacheContaminated } from "./runner.js";
import type {
  BenchQuery,
  BenchmarkManifest,
  CandidateFreeze,
  GateEvaluation,
  JudgmentsFile,
  QueryEvaluation,
  RunAuthority,
  RunRecord,
} from "./types.js";

export interface EvidencePackageInput {
  manifest: BenchmarkManifest;
  judgments: JudgmentsFile;
  aliases: AliasIndex;
  runs: RunRecord[];
  freeze: CandidateFreeze | null;
  authority: RunAuthority;
  environment: HarnessEnvironment;
  notes: string[];
}

export interface EvidencePackage {
  schemaVersion: 1;
  benchmarkId: string;
  authority: RunAuthority;
  productionOutcome: null;
  productionOutcomeNote: string;
  environment: HarnessEnvironment;
  candidateFreeze: CandidateFreeze | null;
  relevanceGate: Omit<GateEvaluation, "authority" | "operational">;
  operationalGates: GateEvaluation["operational"];
  queryEvaluations: QueryEvaluation[];
  notes: string[];
}

/**
 * Turns raw run records into the controlled-evidence package: per-query
 * canonical rankings and deltas, the family-weighted relevance-gate
 * arithmetic, severe-regression checks, diagnostic reports, operational
 * summaries (stage timing, request usage, retries, cost, cache state, declared
 * failure behavior), and completeness findings. The package is sufficient for
 * the later human/operator live acceptance run but never classifies a
 * production acceptance outcome.
 */
export function buildEvidencePackage(input: EvidencePackageInput): EvidencePackage {
  const evaluations = input.manifest.queries
    .filter((query) => query.slice === "headline")
    .map((query) => evaluateQuery(query, input));

  const candidateRuns = input.runs.filter((run) => run.variant === "candidate");
  const costPerRun = candidateRuns.map(costUsdOf);
  const latencyTotalsMs = input.runs
    .filter((run) => !isCacheContaminated(run) && run.exitCode === 0)
    .map((run) => wallOrEnvelopeMs(run));
  const successCount = input.runs.filter(
    (run) => !isCacheContaminated(run) && run.exitCode === 0,
  ).length;

  const relevanceGate = evaluateRelevanceGate({
    queries: input.manifest.queries,
    families: input.manifest.families,
    evaluations,
    seed: input.manifest.seed,
  });
  const operationalGates = evaluateOperationalGates({
    authority: input.authority,
    latencyTotalsMs,
    successCount,
    totalCount: input.runs.length,
    costUsdPerRun: costPerRun,
  });
  if (input.freeze === null) {
    relevanceGate.completenessIssues.push(
      "no candidate freeze present; candidate evidence cannot be traced to an outcome-affecting configuration.",
    );
  }
  const noCandidateRuns = candidateRuns.length === 0;
  if (noCandidateRuns) {
    relevanceGate.completenessIssues.push(
      "no candidate runs captured; baseline-only packages establish the usable-QMD reference only.",
    );
  }

  return {
    schemaVersion: 1,
    benchmarkId: input.manifest.benchmarkId,
    authority: input.authority,
    productionOutcome: null,
    productionOutcomeNote: relevanceGate.productionOutcomeNote,
    environment: input.environment,
    candidateFreeze: input.freeze,
    relevanceGate,
    operationalGates,
    queryEvaluations: evaluations,
    notes: input.notes,
  };
}

function evaluateQuery(query: BenchQuery, input: EvidencePackageInput): QueryEvaluation {
  const grades = input.judgments.grades[query.id] ?? {};
  const baselineRanking = canonicalRankingForRun("baseline", query.id, input);
  const candidateRanking = canonicalRankingForRun("candidate", query.id, input);

  const evaluation: QueryEvaluation = {
    queryId: query.id,
    eligible: false,
    diagnostics: {
      baseline: rankingDiagnostics(baselineRanking.ranking, grades),
      candidate: rankingDiagnostics(candidateRanking.ranking, grades),
    },
  };

  if (query.eligibilityFailure) {
    return { ...evaluation, exclusionReason: "eligibility-failure" };
  }
  if (baselineRanking.reason !== null || candidateRanking.reason !== null) {
    return {
      ...evaluation,
      exclusionReason:
        baselineRanking.reason === "cache-hit" || candidateRanking.reason === "cache-hit"
          ? "cache-hit"
          : baselineRanking.reason === "failed-run" || candidateRanking.reason === "failed-run"
            ? "failed-run"
            : "missing-run",
    };
  }

  const baselineNdcg = ndcgAt10(baselineRanking.ranking, grades);
  const candidateNdcg = ndcgAt10(candidateRanking.ranking, grades);
  if (baselineNdcg === null || candidateNdcg === null) {
    return { ...evaluation, exclusionReason: "no-graded-relevant-documents" };
  }
  const top3Useful = baselineRanking.ranking
    .slice(0, 3)
    .some((canonicalId) => (grades[canonicalId] ?? 0) >= 2);
  const top10Useful = candidateRanking.ranking
    .slice(0, 10)
    .some((canonicalId) => (grades[canonicalId] ?? 0) >= 2);

  return {
    ...evaluation,
    eligible: true,
    baselineNdcg10: baselineNdcg,
    candidateNdcg10: candidateNdcg,
    deltaNdcg10: candidateNdcg - baselineNdcg,
    baselineTop3UsefulLostInCandidateTop10: top3Useful && !top10Useful,
  };
}

interface RankingOutcome {
  ranking: string[];
  reason: "missing-run" | "failed-run" | "cache-hit" | null;
}

function canonicalRankingForRun(
  variant: "baseline" | "candidate",
  queryId: string,
  input: EvidencePackageInput,
): RankingOutcome {
  const record = input.runs.find(
    (run) => run.variant === variant && run.queryId === queryId && run.repeatIndex === 0 && !isCacheContaminated(run),
  );
  const contaminated = input.runs.find(
    (run) => run.variant === variant && run.queryId === queryId && isCacheContaminated(run),
  );
  if (contaminated !== undefined && record === undefined) {
    return { ranking: [], reason: "cache-hit" };
  }
  if (record === undefined || record.resultEnvelope === undefined) {
    return { ranking: [], reason: "missing-run" };
  }
  if (record.exitCode !== 0) {
    return { ranking: [], reason: "failed-run" };
  }
  const envelope = record.resultEnvelope as ResultEnvelope;
  return {
    ranking: canonicalRanking(envelope.results, input.aliases, Number.MAX_SAFE_INTEGER),
    reason: null,
  };
}

export function costUsdOf(record: RunRecord): number {
  const envelope = record.resultEnvelope as ResultEnvelope | undefined;
  if (envelope === undefined) return 0;
  return envelope.pipeline.expansion.metadata.costUsd + envelope.pipeline.reranking.metadata.costUsd;
}

function wallOrEnvelopeMs(record: RunRecord): number {
  const envelope = record.resultEnvelope as ResultEnvelope | undefined;
  return envelope?.timingMs.total ?? record.wallMs;
}

/** Persists the package plus raw run records so #5 can audit every invocation. */
export function writeEvidencePackage(outputDir: string, pkg: EvidencePackage, runs: readonly RunRecord[]): void {
  mkdirSync(join(outputDir, "runs"), { recursive: true });
  writeFileSync(join(outputDir, "evidence.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  writeFileSync(
    join(outputDir, "runs.json"),
    `${JSON.stringify(runs, null, 2)}\n`,
    "utf8",
  );
}
