import type { Clock } from "./clock.js";
import {
  DEFAULT_QUERY_COST_CEILING_USD,
  HARD_END_TO_END_DEADLINE_MS,
} from "./budgets.js";

/**
 * Orchestrator-owned cumulative accounting for one search
 * (docs/spec/qmdx-v1.md, "Cost and time"): the hard end-to-end deadline and
 * the query cost ceiling are owned here, not by the individual stages. Every
 * attempt reserves its conservative worst-case billable cost through this
 * ledger before transmission, so cumulative spend across expansion and
 * reranking can never silently exceed the ceiling.
 */
export interface SearchBudgetLedger {
  /** Monotonic pipeline start timestamp in milliseconds. */
  readonly startedAtMs: number;
  nowMs(): number;
  elapsedMs(): number;
  /** Milliseconds left before the hard end-to-end deadline. */
  remainingGlobalMs(): number;
  /** True once the hard end-to-end deadline has passed. */
  globalExpired(): boolean;
  /** Cumulative conservative worst-case cost reserved so far, USD. */
  spentUsd(): number;
  /**
   * Admits one attempt's conservative worst-case cost against the query
   * ceiling. When true, the estimate has been reserved; when false, nothing
   * was reserved and the attempt must not be transmitted.
   */
  reserveAttemptCost(costUsd: number): boolean;
}

/** Creates the per-search ledger from the injected clock. */
export function createSearchBudget(
  clock: Clock,
  queryCostCeilingUsd: number = DEFAULT_QUERY_COST_CEILING_USD,
  deadlineMs: number = HARD_END_TO_END_DEADLINE_MS,
): SearchBudgetLedger {
  const startedAtMs = clock.nowMs();
  let spentUsd = 0;
  return {
    startedAtMs,
    nowMs: () => clock.nowMs(),
    elapsedMs: () => clock.nowMs() - startedAtMs,
    remainingGlobalMs: () => deadlineMs - (clock.nowMs() - startedAtMs),
    globalExpired: () => clock.nowMs() - startedAtMs >= deadlineMs,
    spentUsd: () => spentUsd,
    reserveAttemptCost(costUsd: number): boolean {
      if (spentUsd + costUsd > queryCostCeilingUsd) return false;
      spentUsd += costUsd;
      return true;
    },
  };
}

/**
 * The time/cost seam a remote stage reads while it runs. The stage budget is
 * cumulative (attempts plus backoff); remaining-time admission always takes
 * the minimum of stage and global remaining so no attempt starts when its
 * duration cannot fit either budget.
 */
export interface StageRuntime {
  clock: Clock;
  /** Milliseconds left in this stage's own cumulative budget. */
  remainingStageMs(): number;
  /** Milliseconds left before the hard end-to-end deadline. */
  remainingGlobalMs(): number;
  /** True once the orchestrator's global deadline has passed. */
  globalExpired(): boolean;
  /**
   * Conservative cost admission against the orchestrator-owned query
   * ceiling. When true the estimate has been reserved.
   */
  reserveAttemptCost(costUsd: number): boolean;
}

/**
 * Wires a stage to the orchestrator's ledger. `stageStartedAtMs` anchors the
 * stage's cumulative budget at the moment the orchestrator handed control to
 * the stage.
 */
export function ledgerStageRuntime(
  clock: Clock,
  ledger: SearchBudgetLedger,
  stageBudgetMs: number,
  stageStartedAtMs: number,
): StageRuntime {
  return {
    clock,
    remainingStageMs: () => stageBudgetMs - (clock.nowMs() - stageStartedAtMs),
    remainingGlobalMs: () => ledger.remainingGlobalMs(),
    globalExpired: () => ledger.globalExpired(),
    reserveAttemptCost: (costUsd) => ledger.reserveAttemptCost(costUsd),
  };
}

/**
 * Self-contained runtime for a stage invoked without the orchestrator (direct
 * unit use): its own fresh stage budget and query ceiling, and no global
 * deadline — global cancellation stays an orchestrator concern.
 */
export function selfContainedStageRuntime(
  clock: Clock,
  stageBudgetMs: number,
  queryCostCeilingUsd: number = DEFAULT_QUERY_COST_CEILING_USD,
): StageRuntime {
  const startedAtMs = clock.nowMs();
  let spentUsd = 0;
  return {
    clock,
    remainingStageMs: () => stageBudgetMs - (clock.nowMs() - startedAtMs),
    remainingGlobalMs: () => Number.POSITIVE_INFINITY,
    globalExpired: () => false,
    reserveAttemptCost(costUsd: number): boolean {
      if (spentUsd + costUsd > queryCostCeilingUsd) return false;
      spentUsd += costUsd;
      return true;
    },
  };
}
