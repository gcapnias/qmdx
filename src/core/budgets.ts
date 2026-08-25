/**
 * Spec cost/time budgets (docs/spec/qmdx-v1.md, "Cost and time").
 * Ticket #12 owns cross-stage orchestration and cumulative accounting;
 * these constants are the single source both stages read.
 */

/** Default hard ceiling on estimated billable remote inference per query. */
export const DEFAULT_QUERY_COST_CEILING_USD = 0.05;

/** Cumulative expansion-stage budget in milliseconds, including attempts and backoff. */
export const DEFAULT_EXPANSION_STAGE_BUDGET_MS = 8_000;

/** Cumulative reranking-stage budget in milliseconds, including attempts and backoff. */
export const DEFAULT_RERANKING_STAGE_BUDGET_MS = 12_000;

/** Hard end-to-end search deadline in milliseconds. */
export const HARD_END_TO_END_DEADLINE_MS = 30_000;

/** Maximum attempts (initial try plus at most one retry) per remote stage. */
export const MAX_ATTEMPTS_PER_STAGE = 2;

/**
 * Upper bound on one attempt's wall-clock wait for the expansion HTTP
 * response. An attempt may never outlive the remaining stage budget; this
 * cap only bounds a single attempt inside a fresh budget.
 */
export const EXPANSION_ATTEMPT_TIMEOUT_CAP_MS = 7_500;

/**
 * Upper bound on one attempt's wall-clock wait for the reranking HTTP
 * response. An attempt may never outlive the remaining stage budget; this
 * cap only bounds a single attempt inside a fresh budget.
 */
export const RERANK_ATTEMPT_TIMEOUT_CAP_MS = 10_000;

/** Base delay for full-jitter retry backoff, bounded by remaining budgets. */
export const RETRY_BACKOFF_BASE_MS = 1_000;
