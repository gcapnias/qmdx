import type { EffectiveRoute } from "../config/resolve.js";
import { resolveCredential } from "../config/resolve.js";
import {
  DEFAULT_EXPANSION_STAGE_BUDGET_MS,
  DEFAULT_QUERY_COST_CEILING_USD,
  EXPANSION_ATTEMPT_TIMEOUT_CAP_MS,
  MAX_ATTEMPTS_PER_STAGE,
  RETRY_BACKOFF_BASE_MS,
} from "../core/budgets.js";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type {
  EnvelopeWarning,
  GeneratedQueryDocument,
} from "../core/envelope.js";
import type { ReasonCode } from "../core/enums.js";
import { QmdxError, internalError } from "../core/errors.js";
import {
  reviewedProviderPricing,
  type ProviderPricingSource,
} from "../core/pricing.js";
import {
  ExpansionInputError,
  admitExpansionInput,
  estimateExpansionAttemptShape,
  estimateWorstCaseAttemptCostUsd,
} from "./admission.js";
import {
  EXPANSION_SYSTEM_PROMPT,
} from "./schema.js";
import {
  ClassifiedAttemptError,
  defaultExpandTransport,
  executeExpansionAttempt,
  type ExpandTransport,
} from "./openai.js";
import { validateGeneratedQueries } from "./validate.js";

/**
 * The expansion stage: the original plain query in, zero or more validated
 * generated retrieval routes out — or an explicit degraded outcome that
 * keeps the original lexical and vector routes
 * (docs/spec/qmdx-v1.md, "Query expansion" and "Degradation").
 */

export interface ExpansionStageInput {
  /** Plain-query expansion input; the only data ever transmitted. */
  plainQuery: string;
}

export interface ExpansionStageOutcome {
  status: "expanded" | "original_sufficient" | "degraded";
  reason: ReasonCode | null;
  generatedQueries: GeneratedQueryDocument[];
  /** Stable degradation warning to surface in the result envelope. */
  warning: EnvelopeWarning | null;
}

export interface ExpansionDeps {
  clock?: Clock;
  transport?: ExpandTransport;
  env?: NodeJS.ProcessEnv;
  pricing?: ProviderPricingSource;
  /** Test seam for deterministic full-jitter backoff. */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the whole expansion stage with at most one retry, conservative cost
 * admission before every attempt, and explicit degradation on any runtime
 * failure. Remote-stage problems degrade; only local-configuration faults
 * throw.
 *
 * Partial valid expansion (at least one surviving entry) succeeds with the
 * valid subset and is never retried; a response whose entries all fail
 * validation is an invalid provider response and may retry once.
 */
export async function runExpansionStage(
  input: ExpansionStageInput,
  route: EffectiveRoute | null,
  deps: ExpansionDeps = {},
): Promise<ExpansionStageOutcome> {
  const clock = deps.clock ?? systemClock;
  const transport = deps.transport ?? defaultExpandTransport;
  const pricing = deps.pricing ?? reviewedProviderPricing;
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? DEFAULT_SLEEP;

  const degraded = (
    reason: ReasonCode,
    message: string,
    retryable: boolean,
  ): ExpansionStageOutcome => ({
    status: "degraded",
    reason,
    generatedQueries: [],
    warning: { stage: "expansion", code: reason, message, retryable },
  });

  try {
    if (route === null) {
      // Handled by the caller with the stable unconfigured-route warning.
      return {
        status: "degraded",
        reason: "provider_unavailable",
        generatedQueries: [],
        warning: null,
      };
    }

    // Local payload admission: oversized or empty input never transmits.
    let admittedQuery: string;
    try {
      admittedQuery = admitExpansionInput(input.plainQuery);
    } catch (error) {
      if (error instanceof ExpansionInputError) {
        return degraded(error.reason, `${error.message} Kept the original lexical and vector routes.`, false);
      }
      throw error;
    }

    const credential = resolveCredential(route, deps.env ?? process.env);
    const rate = pricing.rateFor(route.provider, route.model);
    const shape = estimateExpansionAttemptShape(EXPANSION_SYSTEM_PROMPT, admittedQuery);

    const stageStartedAtMs = clock.nowMs();
    const remainingBudgetMs = () =>
      DEFAULT_EXPANSION_STAGE_BUDGET_MS - (clock.nowMs() - stageStartedAtMs);
    let spentUsd = 0;
    let lastFailure: ClassifiedAttemptError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_STAGE; attempt++) {
      // Cost admission before every attempt: no attempt may be sent unless
      // its worst-case billable cost fits the remaining query ceiling.
      const attemptCostUsd = estimateWorstCaseAttemptCostUsd(shape, rate);
      if (spentUsd + attemptCostUsd > DEFAULT_QUERY_COST_CEILING_USD) {
        return degraded(
          "cost_budget_exceeded",
          `Estimated worst-case expansion cost would exceed the US$${DEFAULT_QUERY_COST_CEILING_USD.toFixed(2)} query ceiling. Kept the original lexical and vector routes.`,
          false,
        );
      }
      if (remainingBudgetMs() <= 0) {
        return degraded(
          "stage_budget_exceeded",
          "The cumulative expansion budget was exhausted before transmission. Kept the original lexical and vector routes.",
          false,
        );
      }

      const timeoutMs = Math.min(remainingBudgetMs(), EXPANSION_ATTEMPT_TIMEOUT_CAP_MS);
      let parsed;
      try {
        parsed = await executeExpansionAttempt(
          route,
          credential,
          admittedQuery,
          transport,
          timeoutMs,
        );
      } catch (error) {
        if (!(error instanceof ClassifiedAttemptError)) {
          throw internalError("The expansion adapter failed unexpectedly.", error);
        }
        lastFailure = error;
        spentUsd += attemptCostUsd;
        if (!error.classification.retryable || attempt === MAX_ATTEMPTS_PER_STAGE) {
          break;
        }
        // Full-jitter backoff bounded by the remaining stage budget; honor
        // Retry-After only when it fits.
        const remainingBeforeBackoff = remainingBudgetMs();
        const waitMs = error.classification.retryAfterMs ??
          Math.floor(rng() * RETRY_BACKOFF_BASE_MS);
        if (waitMs > 0 && waitMs < remainingBeforeBackoff) {
          await sleep(waitMs);
        }
        continue;
      }

      if (parsed.outcome === "original_sufficient") {
        return {
          status: "original_sufficient",
          reason: null,
          generatedQueries: [],
          warning: null,
        };
      }

      // Validate every entry independently; partial valid expansion succeeds
      // without a retry.
      const { queries, discardedCount } = validateGeneratedQueries(
        parsed.entries,
        admittedQuery,
      );
      if (queries.length > 0) {
        return {
          status: "expanded",
          reason: null,
          generatedQueries: queries,
          warning: null,
        };
      }
      // No entry survived: the whole provider response was unusable.
      lastFailure = new ClassifiedAttemptError({
        reason: "invalid_provider_response",
        retryable: true,
        retryAfterMs: null,
        detail:
          discardedCount > 0
            ? `all ${discardedCount} generated queries violated the validation rules`
            : "the provider returned no generated queries for an expanded outcome",
      });
      spentUsd += attemptCostUsd;
      if (attempt === MAX_ATTEMPTS_PER_STAGE) break;
      const remainingBeforeBackoff = remainingBudgetMs();
      const waitMs = Math.floor(rng() * RETRY_BACKOFF_BASE_MS);
      if (waitMs > 0 && waitMs < remainingBeforeBackoff) {
        await sleep(waitMs);
      }
    }

    const classification = lastFailure!.classification;
    return degraded(
      classification.reason as ReasonCode,
      `Expansion failed after ${MAX_ATTEMPTS_PER_STAGE} attempts (${classification.detail}). Kept the original lexical and vector routes.`,
      classification.retryable,
    );
  } catch (error) {
    if (error instanceof QmdxError) throw error;
    return degraded(
      "transport_error",
      `Expansion failed (${error instanceof Error ? error.message : String(error)}). Kept the original lexical and vector routes.`,
      false,
    );
  }
}
