import {
  DEFAULT_QUERY_COST_CEILING_USD,
  MAX_ATTEMPTS_PER_STAGE,
  RETRY_BACKOFF_BASE_MS,
} from "./budgets.js";
import type {
  EnvelopeWarning,
  RemoteStageMetadata,
} from "./envelope.js";
import { internalError } from "./errors.js";
import type { ReasonCode, WarningStage } from "./enums.js";
import type { StageRuntime } from "./search-budget.js";

/**
 * The remote-stage attempt machinery shared by the expansion and reranking
 * stages: bounded attempts with global-deadline cancellation, cumulative
 * stage-budget admission, conservative cost reservation, remaining-time
 * attempt timeouts, and classified retries with bounded full-jitter backoff
 * (docs/spec/qmdx-v1.md, "Cost and time" and "Retries").
 */

export const DEFAULT_STAGE_SLEEP = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FailureClassification {
  reason: ReasonCode;
  retryable: boolean;
  /** Provider-suggested wait in milliseconds, when a Retry-After header exists. */
  retryAfterMs: number | null;
  detail: string;
}

export class ClassifiedAttemptError extends Error {
  readonly classification: FailureClassification;
  constructor(classification: FailureClassification, stageLabel = "Remote-stage") {
    super(`${stageLabel} attempt failed: ${classification.detail}`);
    this.name = "ClassifiedAttemptError";
    this.classification = classification;
  }
}

/** Cumulative per-stage accounting surfaced in the envelope metadata. */
export interface AttemptState {
  attempts: number;
  chargedUsd: number;
}

export function newAttemptState(): AttemptState {
  return { attempts: 0, chargedUsd: 0 };
}

/**
 * Mandatory attempts/retries/cost metadata; extras (usage, cache state) are
 * appended by the caller when present.
 */
export function stageMetadata(
  state: AttemptState,
  extras: Partial<RemoteStageMetadata> = {},
): RemoteStageMetadata {
  return {
    attempts: state.attempts,
    retries: Math.max(0, state.attempts - 1),
    costUsd: Number(state.chargedUsd.toFixed(6)),
    ...extras,
  };
}

export function remoteStageWarning(
  stage: WarningStage,
  code: ReasonCode,
  message: string,
  retryable: boolean,
): EnvelopeWarning {
  return { stage, code, message, retryable };
}

/**
 * Why the loop refused to transmit before or between attempts. All three
 * preclusions degrade non-retryably.
 */
export type PrecludedReason =
  | "global_deadline_exceeded"
  | "stage_budget_exceeded"
  | "cost_budget_exceeded";

export type AttemptLoopOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "precluded"; reason: PrecludedReason }
  | { kind: "exhausted"; classification: FailureClassification };

export interface AttemptLoopOptions<T> {
  runtime: StageRuntime;
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Mutated with every reserved cost and transmitted attempt. */
  state: AttemptState;
  /** Conservative worst-case billable cost of one attempt, USD. */
  estimateCostUsd: () => number;
  /** Hard cap on one attempt's wall-clock timeout for this stage. */
  attemptTimeoutCapMs: number;
  /**
   * Executes exactly one admitted attempt. Must fail only by throwing
   * {@link ClassifiedAttemptError}; anything else escapes as an internal
   * fault.
   */
  executeAttempt: (timeoutMs: number) => Promise<T>;
}

/**
 * Runs at most MAX_ATTEMPTS_PER_STAGE admitted attempts. Before every
 * transmission it checks the hard end-to-end deadline, then the cumulative
 * stage budget, then reserves the attempt's worst-case cost against the
 * query ceiling; an attempt's wall-clock cap is the minimum of the
 * remaining stage budget, the remaining global deadline, and the stage's
 * provider timeout cap. Retryable failures back off once with full jitter,
 * honoring Retry-After only when it fits both budgets.
 */
export async function runAdmittedAttempts<T>(
  options: AttemptLoopOptions<T>,
): Promise<AttemptLoopOutcome<T>> {
  const { runtime, rng, sleep, state } = options;
  let lastFailure: FailureClassification | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_STAGE; attempt++) {
    // Cancellation first: once the hard end-to-end deadline has passed the
    // stage is cancelled, never completed with a late transmission.
    if (runtime.globalExpired()) {
      return { kind: "precluded", reason: "global_deadline_exceeded" };
    }
    if (runtime.remainingStageMs() <= 0) {
      return { kind: "precluded", reason: "stage_budget_exceeded" };
    }
    // Cost admission before every attempt: no attempt may be sent unless
    // its worst-case billable cost fits the remaining query ceiling.
    const attemptCostUsd = options.estimateCostUsd();
    if (!runtime.reserveAttemptCost(attemptCostUsd)) {
      return { kind: "precluded", reason: "cost_budget_exceeded" };
    }
    state.chargedUsd += attemptCostUsd;
    state.attempts += 1;

    // Remaining-time admission: an attempt never starts when its duration
    // cannot fit the remaining stage budget or the global deadline.
    const timeoutMs = Math.min(
      runtime.remainingStageMs(),
      runtime.remainingGlobalMs(),
      options.attemptTimeoutCapMs,
    );
    try {
      return { kind: "success", value: await options.executeAttempt(timeoutMs) };
    } catch (error) {
      if (!(error instanceof ClassifiedAttemptError)) throw error;
      lastFailure = error.classification;
      if (!error.classification.retryable || attempt === MAX_ATTEMPTS_PER_STAGE) {
        break;
      }
      // Full-jitter backoff bounded by the remaining stage budget AND the
      // global deadline; honor Retry-After only when it fits both.
      const allowanceMs = Math.min(runtime.remainingStageMs(), runtime.remainingGlobalMs());
      const waitMs = error.classification.retryAfterMs ??
        Math.floor(rng() * RETRY_BACKOFF_BASE_MS);
      if (waitMs > 0 && waitMs < allowanceMs) {
        await sleep(waitMs);
      }
    }
  }

  if (lastFailure === null) {
    throw internalError("The remote-stage attempt loop ended without a failure classification.");
  }
  return { kind: "exhausted", classification: lastFailure };
}

/**
 * The degraded-outcome message suffix each stage appends to explain what the
 * search fell back to.
 */
export function precludedMessage(
  reason: PrecludedReason,
  stage: "expansion" | "reranking",
): string {
  switch (reason) {
    case "global_deadline_exceeded":
      return stage === "expansion"
        ? "The hard end-to-end search deadline expired; the expansion stage was cancelled. Kept the original lexical and vector routes."
        : "The hard end-to-end search deadline expired; the reranking stage was cancelled. Kept QMD fused order.";
    case "stage_budget_exceeded":
      return stage === "expansion"
        ? "The cumulative expansion budget was exhausted before transmission. Kept the original lexical and vector routes."
        : "The cumulative reranking budget was exhausted before transmission. Kept QMD fused order.";
    case "cost_budget_exceeded":
      return stage === "expansion"
        ? `Estimated worst-case expansion cost would exceed the US$${DEFAULT_QUERY_COST_CEILING_USD.toFixed(2)} query cost budget. Kept the original lexical and vector routes.`
        : `Estimated worst-case reranking cost would exceed the US$${DEFAULT_QUERY_COST_CEILING_USD.toFixed(2)} query cost budget. Kept QMD fused order.`;
  }
}
