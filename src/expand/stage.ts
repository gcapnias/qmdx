import type { EffectiveRoute } from "../config/resolve.js";
import { resolveCredential } from "../config/resolve.js";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  DEFAULT_EXPANSION_STAGE_BUDGET_MS,
  DEFAULT_QUERY_COST_CEILING_USD,
  EXPANSION_ATTEMPT_TIMEOUT_CAP_MS,
  MAX_ATTEMPTS_PER_STAGE,
  RETRY_BACKOFF_BASE_MS,
} from "../core/budgets.js";
import type {
  EnvelopeWarning,
  GeneratedQueryDocument,
  RemoteStageMetadata,
} from "../core/envelope.js";
import type { ReasonCode } from "../core/enums.js";
import { QmdxError, internalError } from "../core/errors.js";
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
  ClassifiedAttemptError,
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
  runtime?: StageRuntime,
): Promise<ExpansionStageOutcome> {
  const clock = deps.clock ?? systemClock;
  const rawTransport = deps.transport ?? defaultExpandTransport;
  const transport = deps.capture
    ? (captureWrapTransport(
        rawTransport,
        deps.capture,
        "expansion",
      ) as unknown as ExpandTransport)
    : rawTransport;
  const pricing = deps.pricing ?? reviewedProviderPricing;
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? DEFAULT_SLEEP;
  // Without an orchestrator-provided runtime the stage is self-contained:
  // fresh stage budget and query ceiling, no global deadline.
  const rt = runtime ?? selfContainedStageRuntime(clock, DEFAULT_EXPANSION_STAGE_BUDGET_MS);

  let attempts = 0;
  let chargedUsd = 0;
  let usage: ExpansionUsage | undefined;
  const cache = deps.expansionCache ?? null;
  // Cache state is surfaced in the envelope metadata only when a cache was
  // actually consulted; absent means uncached (acceptance runs).
  const metadata = (): RemoteStageMetadata => ({
    attempts,
    retries: Math.max(0, attempts - 1),
    costUsd: Number(chargedUsd.toFixed(6)),
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
    warning: { stage: "expansion", code: reason, message, retryable },
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

    let lastFailure: ClassifiedAttemptError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_STAGE; attempt++) {
      // Cancellation first: once the hard end-to-end deadline has passed the
      // stage is cancelled, never completed with a late transmission.
      if (rt.globalExpired()) {
        return degraded(
          "global_deadline_exceeded",
          "The hard end-to-end search deadline expired; the expansion stage was cancelled. Kept the original lexical and vector routes.",
          false,
        );
      }
      if (rt.remainingStageMs() <= 0) {
        return degraded(
          "stage_budget_exceeded",
          "The cumulative expansion budget was exhausted before transmission. Kept the original lexical and vector routes.",
          false,
        );
      }
      // Cost admission before every attempt: no attempt may be sent unless
      // its worst-case billable cost fits the remaining query ceiling. The
      // estimate is reserved against the orchestrator's cumulative ledger.
      const attemptCostUsd = estimateWorstCaseAttemptCostUsd(shape, rate);
      if (!rt.reserveAttemptCost(attemptCostUsd)) {
        return degraded(
          "cost_budget_exceeded",
          `Estimated worst-case expansion cost would exceed the US$${DEFAULT_QUERY_COST_CEILING_USD.toFixed(2)} query cost budget. Kept the original lexical and vector routes.`,
          false,
        );
      }
      chargedUsd += attemptCostUsd;
      attempts += 1;

      // Remaining-time admission: an attempt never starts when its duration
      // cannot fit the remaining stage budget or the global deadline.
      const timeoutMs = Math.min(
        rt.remainingStageMs(),
        rt.remainingGlobalMs(),
        EXPANSION_ATTEMPT_TIMEOUT_CAP_MS,
      );
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
        if (!error.classification.retryable || attempt === MAX_ATTEMPTS_PER_STAGE) {
          break;
        }
        // Full-jitter backoff bounded by the remaining stage budget AND the
        // global deadline; honor Retry-After only when it fits both.
        const allowanceMs = Math.min(rt.remainingStageMs(), rt.remainingGlobalMs());
        const waitMs = error.classification.retryAfterMs ??
          Math.floor(rng() * RETRY_BACKOFF_BASE_MS);
        if (waitMs > 0 && waitMs < allowanceMs) {
          await sleep(waitMs);
        }
        continue;
      }

      if (parsed.usage !== undefined) usage = parsed.usage;

      if (parsed.outcome === "original_sufficient") {
        if (cache !== null) {
          cache.store.put(
            expansionCacheIdentity(route, cache, admittedQuery),
            { outcome: "original_sufficient", queries: [] },
          );
        }
        return {
          status: "original_sufficient",
          reason: null,
          generatedQueries: [],
          warning: null,
          metadata: metadata(),
        };
      }

      // Validate every entry independently; partial valid expansion succeeds
      // without a retry.
      const { queries, discardedCount } = validateGeneratedQueries(
        parsed.entries,
        admittedQuery,
      );
      if (queries.length > 0) {
        // Only the fully validated result is cached; the stored value is the
        // generated-query set — never a credential and never corpus content.
        if (cache !== null) {
          cache.store.put(
            expansionCacheIdentity(route, cache, admittedQuery),
            { outcome: "expanded", queries },
          );
        }
        return {
          status: "expanded",
          reason: null,
          generatedQueries: queries,
          warning: null,
          metadata: metadata(),
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
      if (attempt === MAX_ATTEMPTS_PER_STAGE) break;
      const allowanceMs = Math.min(rt.remainingStageMs(), rt.remainingGlobalMs());
      const waitMs = Math.floor(rng() * RETRY_BACKOFF_BASE_MS);
      if (waitMs > 0 && waitMs < allowanceMs) {
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

const GENERATION_TYPES: ReadonlySet<string> = new Set(["lex", "vec", "hyde"]);
const GENERATION_LANGUAGES: ReadonlySet<string> = new Set(["en", "el", "und"]);
const GENERATION_PURPOSES: ReadonlySet<string> = new Set([
  "terminology",
  "translation",
  "semantic",
  "hypothetical",
]);

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
      !GENERATION_LANGUAGES.has(doc.language as string) ||
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
