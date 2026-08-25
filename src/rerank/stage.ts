import type { HybridQueryResult } from "@tobilu/qmd";
import type { EffectiveRoute } from "../config/resolve.js";
import { resolveCredential } from "../config/resolve.js";
import {
  DEFAULT_RERANKING_STAGE_BUDGET_MS,
  MAX_ATTEMPTS_PER_STAGE,
  RERANK_ATTEMPT_TIMEOUT_CAP_MS,
} from "../core/budgets.js";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { ReasonCode } from "../core/enums.js";
import type {
  EnvelopeWarning,
  RemoteStageMetadata,
} from "../core/envelope.js";
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
import { rerankCacheIdentity } from "./cache.js";
import { captureWrapTransport, type PayloadSink } from "../core/capture.js";
import {
  admitRerankRequest,
  estimateWorstCaseAttemptCostUsd,
  PayloadLimitExceededError,
} from "./admission.js";
import {
  defaultRerankTransport,
  executeCohereAttempt,
  classifyFailure,
  type RerankTransport,
} from "./cohere.js";
import { identityOf } from "../pipeline/identity.js";

/**
 * The reranking stage: one unreranked QMD candidate pool in, one Cohere
 * request out, validated remote scores back — or an explicit degraded
 * outcome that keeps the QMD fused order (docs/spec/qmdx-v1.md).
 */

export interface RerankingStageInput {
  pool: HybridQueryResult[];
  /** Exact user query; generated expansion routes never enter this stage. */
  originalQuery: string;
  intent: string | null;
}

export interface RerankingStageReport {
  status: "ok" | "degraded" | "disabled";
  reason: ReasonCode | null;
}

export interface RerankingStageOutcome {
  report: RerankingStageReport;
  /** Remote score per successfully reranked pool entry; null when none. */
  remoteRerankScores: Map<HybridQueryResult, number> | null;
  /** Stable degradation warning to surface in the result envelope. */
  warning: EnvelopeWarning | null;
  /** Mandatory attempts/retries/cost metadata for the result envelope. */
  metadata: RemoteStageMetadata;
}

export interface RerankingDeps {
  clock?: Clock;
  transport?: RerankTransport;
  env?: NodeJS.ProcessEnv;
  pricing?: ProviderPricingSource;
  /** Test seam for deterministic full-jitter backoff. */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Opt-in persistent reranking response cache. When present, a valid
   * cached score set for the exact request identity (ordered candidate
   * identities and chunk hashes included) is returned without any
   * transmission, cost reservation, or credential requirement.
   */
  rerankCache?: StageCacheBinding;
  /**
   * Explicit warned sensitive-payload-capture sink. When present, every
   * transmitted attempt's request and response (or failure) is recorded.
   */
  capture?: PayloadSink;
}

/**
 * The reranking query is optional intent plus the original query; generated
 * expansion routes are retrieval routes and never enter it.
 */
export function buildRerankingQuery(
  originalQuery: string,
  intent: string | null,
): string {
  return intent !== null && intent.trim() !== ""
    ? `${intent}\n\n${originalQuery}`
    : originalQuery;
}

export interface AssembledCandidate {
  identity: string;
  poolIndex: number;
  chunk: string;
  /** The pool entry this candidate came from; stays local, never sent. */
  entry: HybridQueryResult;
}

interface CandidateAssembly {
  documents: AssembledCandidate[];
}

/**
 * Assembles the production reranking payload: every candidate stays a
 * distinct entry (identical chunks included) and sends only its exact
 * non-empty QMD-selected chunk. Entries without a usable selected chunk
 * cannot be sent at all; they stay out of the request.
 */
export function assembleCandidates(
  pool: HybridQueryResult[],
): CandidateAssembly {
  const documents: AssembledCandidate[] = [];
  pool.forEach((entry, poolIndex) => {
    const chunk = entry.bestChunk;
    if (typeof chunk !== "string" || chunk.trim() === "") return;
    documents.push({ identity: identityOf(entry), poolIndex, chunk, entry });
  });
  return { documents };
}

function scoredOutcome(
  documents: AssembledCandidate[],
  scores: readonly number[],
): Map<HybridQueryResult, number> {
  // Both arrays were validated to the same length before this point, so
  // plain iteration pairs every candidate with its request-local score.
  const remoteRerankScores = new Map<HybridQueryResult, number>();
  let index = 0;
  for (const score of scores) {
    const candidate = documents[index++];
    if (candidate !== undefined) remoteRerankScores.set(candidate.entry, score);
  }
  return remoteRerankScores;
}

/**
 * Runs the whole reranking stage with at most one retry, conservative cost
 * admission before every attempt, and explicit degradation on any runtime
 * failure. Remote-stage problems degrade; only local-configuration faults
 * throw.
 */
export async function runRerankingStage(
  input: RerankingStageInput,
  route: EffectiveRoute | null,
  deps: RerankingDeps = {},
  runtime?: StageRuntime,
): Promise<RerankingStageOutcome> {
  const clock = deps.clock ?? systemClock;
  const rawTransport = deps.transport ?? defaultRerankTransport;
  const transport = deps.capture
    ? captureWrapTransport(rawTransport, deps.capture, "reranking")
    : rawTransport;
  const pricing = deps.pricing ?? reviewedProviderPricing;
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? DEFAULT_STAGE_SLEEP;
  // Without an orchestrator-provided runtime the stage is self-contained:
  // fresh stage budget and query ceiling, no global deadline.
  const rt = runtime ?? selfContainedStageRuntime(clock, DEFAULT_RERANKING_STAGE_BUDGET_MS);

  const state = newAttemptState();
  const cache = deps.rerankCache ?? null;
  // Cache state is surfaced in the envelope metadata only when a cache was
  // actually consulted; absent means uncached (acceptance runs).
  const metadata = () =>
    stageMetadata(state, cache === null ? {} : { cache: "miss" as const });

  const degraded = (
    reason: ReasonCode,
    message: string,
    retryable: boolean,
  ): RerankingStageOutcome => ({
    report: { status: "degraded", reason },
    remoteRerankScores: null,
    warning: remoteStageWarning("reranking", reason, message, retryable),
    metadata: metadata(),
  });

  try {
    if (route === null) {
      // Handled by the caller with the stable unconfigured-route warning.
      return {
        report: { status: "degraded", reason: "provider_unavailable" },
        remoteRerankScores: null,
        warning: null,
        metadata: metadata(),
      };
    }
    if (input.pool.length === 0) {
      // Nothing was retrieved, so there is nothing to rerank.
      return {
        report: { status: "ok", reason: null },
        remoteRerankScores: null,
        warning: null,
        metadata: metadata(),
      };
    }

    const assembly = assembleCandidates(input.pool);
    if (assembly.documents.length === 0) {
      return degraded(
        "payload_limit_exceeded",
        "No candidate carries a non-empty selected chunk to send. Kept QMD fused order.",
        false,
      );
    }
    if (assembly.documents.length < input.pool.length) {
      // Sending only the eligible candidates would mix blended scores with
      // position scores while the envelope still reported status "ok".
      // One uniform score meaning per pipeline state wins, so the whole
      // request is withheld and every result keeps its position score.
      return degraded(
        "payload_limit_exceeded",
        "Some candidates carry no non-empty selected chunk to send; the reranking request was withheld so every result keeps one uniform score semantics. Kept QMD fused order.",
        false,
      );
    }
    const admitted = admitRerankRequest(
      buildRerankingQuery(input.originalQuery, input.intent),
      assembly.documents,
    );

    // Opt-in cache lookup keyed by the full request identity (ordered
    // candidate identities and selected-chunk hashes included): a valid
    // cached score set returns with zero attempts and zero cost — no
    // credential resolution, cost reservation, or transmission.
    if (cache !== null) {
      const cachedScores = readCachedScores(
        cache.store.get(
          rerankCacheIdentity(
            route,
            cache,
            buildRerankingQuery(input.originalQuery, input.intent),
            assembly.documents,
          ),
        ),
        assembly.documents.length,
      );
      if (cachedScores !== null) {
        return {
          report: { status: "ok", reason: null },
          remoteRerankScores: scoredOutcome(assembly.documents, cachedScores),
          warning: null,
          metadata: { attempts: 0, retries: 0, costUsd: 0, cache: "hit" },
        };
      }
    }

    const credential = resolveCredential(route, deps.env ?? process.env);
    const rate = pricing.rateFor(route.provider, route.model);

    const loop = await runAdmittedAttempts({
      runtime: rt,
      rng,
      sleep,
      state,
      estimateCostUsd: () => estimateWorstCaseAttemptCostUsd(admitted, rate),
      attemptTimeoutCapMs: RERANK_ATTEMPT_TIMEOUT_CAP_MS,
      executeAttempt: async (timeoutMs) => {
        try {
          return await executeCohereAttempt(route, credential, admitted, transport, timeoutMs);
        } catch (error) {
          if (error instanceof ClassifiedAttemptError) throw error;
          throw internalError("The reranking adapter failed unexpectedly.", error);
        }
      },
    });

    if (loop.kind === "precluded") {
      return degraded(loop.reason, precludedMessage(loop.reason, "reranking"), false);
    }
    if (loop.kind === "exhausted") {
      const { classification } = loop;
      return degraded(
        classification.reason,
        `Reranking failed after ${MAX_ATTEMPTS_PER_STAGE} attempts (${classification.detail}). Kept QMD fused order.`,
        classification.retryable,
      );
    }

    const scores = loop.value;
    // Only the fully validated request-local score array is cached —
    // never a credential, never the selected chunks themselves.
    if (cache !== null) {
      cache.store.put(
        rerankCacheIdentity(
          route,
          cache,
          buildRerankingQuery(input.originalQuery, input.intent),
          assembly.documents,
        ),
        scores,
      );
    }
    return {
      report: { status: "ok", reason: null },
      remoteRerankScores: scoredOutcome(assembly.documents, scores),
      warning: null,
      metadata: metadata(),
    };
  } catch (error) {
    if (error instanceof PayloadLimitExceededError) {
      return degraded(error.reason, `${error.message} Kept QMD fused order.`, false);
    }
    if (error instanceof QmdxError) throw error;
    const failure = classifyFailure(error, null);
    return degraded(failure.reason, `Reranking failed (${failure.detail}). Kept QMD fused order.`, failure.retryable);
  }
}

/**
 * Re-validates a cached score array before use: exactly one finite [0,1]
 * score per submitted candidate, in request order. Anything else is treated
 * as a cache miss rather than trusted.
 */
export function readCachedScores(
  value: unknown,
  expectedCount: number,
): number[] | null {
  if (!Array.isArray(value) || value.length !== expectedCount) return null;
  const scores: number[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "number" ||
      !Number.isFinite(entry) ||
      entry < 0 ||
      entry > 1
    ) {
      return null;
    }
    scores.push(entry);
  }
  return scores;
}
