import type {
  BenchFamily,
  BenchQuery,
  GateEvaluation,
  GateSummary,
  QueryEvaluation,
  RankingDiagnostics,
  RelevanceGrade,
} from "./types.js";
import { FROZEN_FAMILY_COUNT } from "./validate.js";

export const GRADE_USEFUL = 2;

export interface MetricInputs {
  queries: BenchQuery[];
  families: BenchFamily[];
  evaluations: QueryEvaluation[];
  seed: number;
}

const MAGNITUDE_THRESHOLD = 0.05;
const SEVERE_LOSS_THRESHOLD = -0.1;
const MAX_SEVERE_LOSS_SHARE = 0.2;
const LATENCY_MEDIAN_MAX_MS = 8000;
const LATENCY_P95_MAX_MS = 15000;
const LATENCY_MAX_MS = 30000;
const RELIABILITY_MIN_SUCCESS = 0.99;
const COST_MEAN_MAX_USD = 0.01;
const COST_P95_MAX_USD = 0.02;
const COST_MAX_USD = 0.05;

/**
 * Computes the relevance gate arithmetic (spec lines 708-723) and the
 * diagnostic reports. The result is evidence, never an acceptance outcome:
 * the harness cannot emit accepted/rejected/inconclusive production verdicts.
 */
export function evaluateRelevanceGate(inputs: MetricInputs): Omit<GateEvaluation, "authority" | "operational"> {
  const issues: string[] = [];
  const eligible = inputs.evaluations.filter((evaluation) => evaluation.eligible);
  for (const evaluation of inputs.evaluations) {
    if (!evaluation.eligible) {
      issues.push(
        `query "${evaluation.queryId}" excluded from the primary aggregate (${evaluation.exclusionReason ?? "unknown"}).`,
      );
    }
  }

  const deltasByQuery = new Map(eligible.map((evaluation) => [evaluation.queryId, evaluation.deltaNdcg10!]));

  const familyStats = inputs.families.map((family) => {
    const familyDeltas = family.queryIds
      .map((queryId) => deltasByQuery.get(queryId))
      .filter((delta): delta is number => delta !== undefined);
    return { family, deltas: familyDeltas };
  });

  const weightedFamilies = familyStats.filter((stat) => stat.deltas.length > 0);
  for (const stat of familyStats) {
    if (stat.deltas.length === 0) {
      issues.push(`topic family "${stat.family.id}" has no eligible headline queries.`);
    }
  }
  const familyWeightedMeanDelta =
    weightedFamilies.length > 0
      ? weightedFamilies.reduce((sum, stat) => sum + mean(stat.deltas), 0) / weightedFamilies.length
      : null;
  const familiesImproved = weightedFamilies.filter((stat) => mean(stat.deltas) > 0).length;
  const familiesWithEligibleQueries = weightedFamilies.length;

  const magnitudePass =
    familyWeightedMeanDelta === null ? null : familyWeightedMeanDelta >= MAGNITUDE_THRESHOLD;
  const majorityPass =
    weightedFamilies.length === 0
      ? null
      : familiesImproved > weightedFamilies.length / 2 &&
        familiesWithEligibleQueries === FROZEN_FAMILY_COUNT;

  const severeLosses = eligible.filter((evaluation) => evaluation.deltaNdcg10! < SEVERE_LOSS_THRESHOLD);
  const regressionRate = eligible.length > 0 ? severeLosses.length / eligible.length : null;
  const regressionPass = regressionRate === null ? null : regressionRate <= MAX_SEVERE_LOSS_SHARE;
  for (const evaluation of eligible) {
    if (evaluation.deltaNdcg10! < SEVERE_LOSS_THRESHOLD) {
      (evaluation as { severeRegressionLoss?: boolean }).severeRegressionLoss = true;
    }
    if (evaluation.baselineTop3UsefulLostInCandidateTop10) {
      issues.push(
        `query "${evaluation.queryId}": baseline top-3 grade-2/3 document lost — no grade-2/3 QMDX document in the top 10.`,
      );
    }
  }

  const top3AnchorFailures = eligible.filter((evaluation) => evaluation.baselineTop3UsefulLostInCandidateTop10);
  const top3AnchorPass =
    eligible.length === 0 ? null : top3AnchorFailures.length === 0 ? true : false;

  const bootstrap95 =
    weightedFamilies.length > 0 && familyWeightedMeanDelta !== null
      ? familyBootstrapInterval(weightedFamilies.map((stat) => mean(stat.deltas)), inputs.seed)
      : null;

  const aggregateNonPositive = familyWeightedMeanDelta !== null && familyWeightedMeanDelta <= 0;
  const hardFailures: string[] = [];
  if (regressionPass === false) {
    hardFailures.push(
      `severe relevance regression: ${severeLosses.length}/${eligible.length} eligible queries lose more than 0.10.`,
    );
  }
  if (top3AnchorPass === false) {
    hardFailures.push("a baseline top-3 grade-2/3 query has no grade-2/3 document in the QMDX top 10.");
  }
  if (aggregateNonPositive) {
    hardFailures.push("aggregate relevance is zero or negative.");
  }

  let evaluation: GateEvaluation["evaluation"];
  if (eligible.length === 0 || familyWeightedMeanDelta === null) {
    evaluation = "insufficient-evidence";
  } else if (hardFailures.length > 0) {
    evaluation = "gate-fail";
  } else if (
    familiesWithEligibleQueries < FROZEN_FAMILY_COUNT ||
    issues.some((issue) => issue.includes("excluded from the primary aggregate"))
  ) {
    evaluation = "incomplete-evidence";
  } else if ((magnitudePass === true) && (majorityPass === true)) {
    evaluation = "gates-pass";
  } else {
    // Complete and positive but missing the magnitude or majority-family rule.
    evaluation = "incomplete-evidence";
    issues.push(
      "relevance evidence is positive but misses the +0.05 magnitude or majority-family rule; this is inconclusive territory and never an improvement.",
    );
  }

  return {
    productionOutcome: null,
    productionOutcomeNote:
      "Controlled or candidate-package evidence only: the accepted/rejected/inconclusive production classification requires live acceptance evidence gathered by a human operator on the target workstation.",
    eligibleQueryCount: eligible.length,
    familyWeightedMeanDelta,
    familiesImproved,
    familiesWithEligibleQueries,
    magnitudePass,
    majorityPass,
    regressionRate,
    regressionPass,
    top3AnchorPass,
    bootstrap95,
    completenessIssues: issues,
    evaluation,
    gateFailReasons: hardFailures,
  };
}

export function evaluateOperationalGates(input: {
  authority: GateEvaluation["authority"];
  latencyTotalsMs: number[];
  successCount: number;
  totalCount: number;
  costUsdPerRun: number[];
}): GateEvaluation["operational"] {
  const live = input.authority === "live-candidate-package";
  return {
    latency: evaluateLatency(input.latencyTotalsMs),
    reliability: evaluateReliability(input.successCount, input.totalCount, live),
    cost: evaluateCost(input.costUsdPerRun, live),
  };
}

function evaluateLatency(totalsMs: number[]): GateSummary {
  if (totalsMs.length === 0) {
    return { measured: false, threshold: "median<=8s, p95<=15s, max<=30s", value: null, pass: null,
      detail: "no completed runs captured" };
  }
  const sorted = [...totalsMs].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = sorted[sorted.length - 1]!;
  const pass = median <= LATENCY_MEDIAN_MAX_MS && p95 <= LATENCY_P95_MAX_MS && max <= LATENCY_MAX_MS;
  return {
    measured: true,
    threshold: "median<=8s, p95<=15s, max<=30s",
    value: median / 1000,
    pass,
    detail: `median=${(median / 1000).toFixed(2)}s p95=${(p95 / 1000).toFixed(2)}s max=${(max / 1000).toFixed(2)}s`,
  };
}

function evaluateReliability(successes: number, total: number, live: boolean): GateSummary {
  void live;
  if (total === 0) {
    return { measured: false, threshold: ">=99% complete successfully", value: null, pass: null,
      detail: "no runs captured" };
  }
  const rate = successes / total;
  return {
    measured: true,
    threshold: ">=99% complete successfully",
    value: rate,
    pass: rate >= RELIABILITY_MIN_SUCCESS,
    detail: `${successes}/${total} runs completed`,
  };
}

function evaluateCost(costs: number[], live: boolean): GateSummary {
  void live;
  if (costs.length === 0) {
    return { measured: false, threshold: "mean<=0.01, p95<=0.02, max<=0.05 USD", value: null, pass: null,
      detail: "no candidate runs captured" };
  }
  const sorted = [...costs].sort((a, b) => a - b);
  const meanCost = costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
  const p95 = percentile(sorted, 0.95);
  const max = sorted[sorted.length - 1]!;
  return {
    measured: true,
    threshold: "mean<=0.01, p95<=0.02, max<=0.05 USD",
    value: meanCost,
    pass: meanCost <= COST_MEAN_MAX_USD && p95 <= COST_P95_MAX_USD && max <= COST_MAX_USD,
    detail: `mean=$${meanCost.toFixed(4)} p95=$${p95.toFixed(4)} max=$${max.toFixed(4)}`,
  };
}

export function rankingDiagnostics(
  ranking: readonly string[],
  grades: Readonly<Record<string, RelevanceGrade>>,
): RankingDiagnostics {
  const top10 = ranking.slice(0, 10);
  const top10Grades = top10.map((canonicalId) => grades[canonicalId] ?? 0);
  const usefulTotal = Object.values(grades).filter((grade) => grade >= GRADE_USEFUL).length;
  const usefulInTop10 = top10Grades.filter((grade) => grade >= GRADE_USEFUL).length;
  let mrr = 0;
  for (let index = 0; index < top10Grades.length; index++) {
    if (top10Grades[index]! >= GRADE_USEFUL) {
      mrr = 1 / (index + 1);
      break;
    }
  }
  return {
    recallAt10: usefulTotal === 0 ? 0 : usefulInTop10 / usefulTotal,
    mrrToFirstGrade2Or3: mrr,
    successAt3: top10Grades.slice(0, 3).some((grade) => grade >= GRADE_USEFUL),
    top10Grades,
  };
}

/** Deterministic 95% bootstrap interval over equal-weight topic families. */
export function familyBootstrapInterval(
  familyMeans: readonly number[],
  seed: number,
): { low: number; high: number } {
  const draws = 10000;
  const rng = mulberry32(seed >>> 0);
  const samples: number[] = [];
  for (let iteration = 0; iteration < draws; iteration++) {
    let sum = 0;
    for (let index = 0; index < familyMeans.length; index++) {
      sum += familyMeans[Math.floor(rng() * familyMeans.length)]!;
    }
    samples.push(sum / familyMeans.length);
  }
  samples.sort((a, b) => a - b);
  return {
    low: samples[Math.floor(draws * 0.025)]!,
    high: samples[Math.floor(draws * 0.975)]!,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: readonly number[], q: number): number {
  const index = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
