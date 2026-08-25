import type { EffectiveRoute } from "../config/resolve.js";
import { resolveCredential } from "../config/resolve.js";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  DEFAULT_EXPANSION_STAGE_BUDGET_MS,
  EXPANSION_ATTEMPT_TIMEOUT_CAP_MS,
  MAX_ATTEMPTS_PER_STAGE,
} from "../core/budgets.js";
import type {
  EnvelopeWarning,
  GeneratedQueryDocument,
  RemoteStageMetadata,
} from "../core/envelope.js";
import type { ReasonCode } from "../core/enums.js";
import {
  GENERATED_QUERY_TYPES,
  GENERATION_LANGUAGES,
  GENERATION_PURPOSES_BY_TYPE,
} from "../core/enums.js";
import { QmdxError, internalError } from "../core/errors.js";
import {
  ClassifiedAttemptError,
  DEFAULT_STAGE_SLEEP,
  newAttemptState,
  precludedMessage,
  remoteStageWarning,
  runAdmittedAttempts,
  stageMetadata,
} from "../core/remote-stage.js";
import {
  selfContainedStageRuntime,
  type StageRuntime,
} from "../core/search-budget.js";
import {
  reviewedProviderPricing,
  type ProviderPricingSource,
} from "../core/pricing.js";
import type { StageCacheBinding } from "../core/cache.js";
import { expansionCacheIdentity } from "./cache.js";
import { captureWrapTransport, type PayloadSink } from "../core/capture.js";
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
  defaultExpandTransport,
  executeExpansionAttempt,
  type ExpandTransport,
  type ExpansionUsage,
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
  /** Mandatory attempts/retries/cost metadata for the result envelope. */
  metadata: RemoteStageMetadata;
}

export interface ExpansionDeps {
  clock?: Clock;
  transport?: ExpandTransport;
  env?: NodeJS.ProcessEnv;
  pricing?: ProviderPricingSource;
  /** Test seam for deterministic full-jitter backoff. */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Opt-in persistent expansion response cache. When present, a valid
   * cached result for the exact stage identity is returned without any
   * transmission, cost reservation, or credential requirement.
   */
  expansionCache?: StageCacheBinding;
  /**
   * Explicit warned sensitive-payload-capture sink. When present, every
   * transmitted attempt's request and response (or failure) is recorded.
   */
  capture?: PayloadSink;
}

interface SuccessfulExpansion {
  outcome: "expanded" | "original_sufficient";
  queries: GeneratedQueryDocument[];
}

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
  runtime?: StageRuntime,
): Promise<ExpansionStageOutcome> {
  const clock = deps.clock ?? systemClock;
  const rawTransport = deps.transport ?? defaultExpandTransport;
  const transport = deps.capture
    ? captureWrapTransport(rawTransport, deps.capture, "expansion")
    : rawTransport;
  const pricing = deps.pricing ?? reviewedProviderPricing;
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? DEFAULT_STAGE_SLEEP;
  // Without an orchestrator-provided runtime the stage is self-contained:
  // fresh stage budget and query ceiling, no global deadline.
  const rt = runtime ?? selfContainedStageRuntime(clock, DEFAULT_EXPANSION_STAGE_BUDGET_MS);

  const state = newAttemptState();
  let usage: ExpansionUsage | undefined;
  const cache = deps.expansionCache ?? null;
  // Cache state is surfaced in the envelope metadata only when a cache was
  // actually consulted; absent means uncached (acceptance runs).
  const metadata = () =>
    stageMetadata(state, {
      ...(usage === undefined ? {} : { usage }),
      ...(cache === null ? {} : { cache: "miss" as const }),
    });

  const degraded = (
    reason: ReasonCode,
    message: string,
    retryable: boolean,
  ): ExpansionStageOutcome => ({
    status: "degraded",
    reason,
    generatedQueries: [],
    warning: remoteStageWarning("expansion", reason, message, retryable),
    metadata: metadata(),
  });

  try {
    if (route === null) {
      // Handled by the caller with the stable unconfigured-route warning.
      return {
        status: "degraded",
        reason: "provider_unavailable",
        generatedQueries: [],
        warning: null,
        metadata: metadata(),
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

    // Opt-in cache lookup: a valid cached result for this exact identity is
    // returned with zero attempts and zero cost — no credential resolution,
    // no cost reservation, no transmission (required-remote accepts it).
    if (cache !== null) {
      const cached = readCachedExpansion(
        cache.store.get(expansionCacheIdentity(route, cache, admittedQuery)),
      );
      if (cached !== null) {
        return {
          status: cached.outcome,
          reason: null,
          generatedQueries: cached.queries,
          warning: null,
          metadata: { attempts: 0, retries: 0, costUsd: 0, cache: "hit" },
        };
      }
    }

    const credential = resolveCredential(route, deps.env ?? process.env);
    const rate = pricing.rateFor(route.provider, route.model);
    const shape = estimateExpansionAttemptShape(EXPANSION_SYSTEM_PROMPT, admittedQuery);

    const loop = await runAdmittedAttempts({
      runtime: rt,
      rng,
      sleep,
      state,
      estimateCostUsd: () => estimateWorstCaseAttemptCostUsd(shape, rate),
      attemptTimeoutCapMs: EXPANSION_ATTEMPT_TIMEOUT_CAP_MS,
      executeAttempt: async (timeoutMs) => {
        let parsed;
        try {
          parsed = await executeExpansionAttempt(route, credential, admittedQuery, transport, timeoutMs);
        } catch (error) {
          if (error instanceof ClassifiedAttemptError) throw error;
          throw internalExpansionFault(error);
        }
        // Provider-reported usage rides on the raw attempt even when its
        // generated entries all fail validation below.
        if (parsed.usage !== undefined) usage = parsed.usage;

        if (parsed.outcome === "original_sufficient") {
          const sufficient: SuccessfulExpansion = {
            outcome: "original_sufficient",
            queries: [],
          };
          return sufficient;
        }

        // Validate every entry independently; partial valid expansion
        // succeeds without a retry. No entry surviving means the whole
        // provider response was unusable and may retry once.
        const { queries, discardedCount } = validateGeneratedQueries(
          parsed.entries,
          admittedQuery,
        );
        if (queries.length === 0) {
          throw new ClassifiedAttemptError(
            {
              reason: "invalid_provider_response",
              retryable: true,
              retryAfterMs: null,
              detail:
                discardedCount > 0
                  ? `all ${discardedCount} generated queries violated the validation rules`
                  : "the provider returned no generated queries for an expanded outcome",
            },
            "Expansion",
          );
        }
        const expanded: SuccessfulExpansion = { outcome: "expanded", queries };
        return expanded;
      },
    });

    if (loop.kind === "precluded") {
      return degraded(loop.reason, precludedMessage(loop.reason, "expansion"), false);
    }
    if (loop.kind === "exhausted") {
      const { classification } = loop;
      return degraded(
        classification.reason,
        `Expansion failed after ${MAX_ATTEMPTS_PER_STAGE} attempts (${classification.detail}). Kept the original lexical and vector routes.`,
        classification.retryable,
      );
    }

    const success: SuccessfulExpansion = loop.value;
    // Only the fully validated result is cached; the stored value is the
    // generated-query set — never a credential and never corpus content.
    if (cache !== null) {
      cache.store.put(
        expansionCacheIdentity(route, cache, admittedQuery),
        { outcome: success.outcome, queries: success.queries },
      );
    }
    return {
      status: success.outcome,
      reason: null,
      generatedQueries: success.queries,
      warning: null,
      metadata: metadata(),
    };
  } catch (error) {
    if (error instanceof QmdxError) throw error;
    return degraded(
      "transport_error",
      `Expansion failed (${error instanceof Error ? error.message : String(error)}). Kept the original lexical and vector routes.`,
      false,
    );
  }
}

function internalExpansionFault(error: unknown): Error {
  if (error instanceof ClassifiedAttemptError) return error;
  return internalError("The expansion adapter failed unexpectedly.", error);
}

// Single-sourced validation vocabularies, derived from core/enums.ts.
const GENERATION_TYPES: ReadonlySet<string> = new Set(GENERATED_QUERY_TYPES);
const GENERATION_LANGUAGES_SET: ReadonlySet<string> = new Set(GENERATION_LANGUAGES);
const GENERATION_PURPOSES: ReadonlySet<string> = new Set(
  Object.values(GENERATION_PURPOSES_BY_TYPE).flat(),
);

/**
 * Re-validates a cached expansion response before use. Anything malformed,
 * stale-shaped, or from a previous schema is treated as a cache miss rather
 * than trusted.
 */
export function readCachedExpansion(
  value: unknown,
): { outcome: "expanded" | "original_sufficient"; queries: GeneratedQueryDocument[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome !== "expanded" && outcome !== "original_sufficient") {
    return null;
  }
  const queries = record.queries;
  if (!Array.isArray(queries)) return null;
  const parsed: GeneratedQueryDocument[] = [];
  for (const entry of queries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const doc = entry as Record<string, unknown>;
    if (
      typeof doc.query !== "string" ||
      !GENERATION_TYPES.has(doc.type as string) ||
      !GENERATION_LANGUAGES_SET.has(doc.language as string) ||
      !GENERATION_PURPOSES.has(doc.purpose as string)
    ) {
      return null;
    }
    parsed.push({
      type: doc.type as GeneratedQueryDocument["type"],
      query: doc.query,
      language: doc.language as GeneratedQueryDocument["language"],
      purpose: doc.purpose as GeneratedQueryDocument["purpose"],
    });
  }
  if (outcome === "original_sufficient" && parsed.length > 0) return null;
  if (outcome === "expanded" && parsed.length === 0) return null;
  return { outcome, queries: parsed };
}
