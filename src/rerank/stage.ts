import type { HybridQueryResult } from "@tobilu/qmd";
import type { EffectiveRoute } from "../config/resolve.js";
import { resolveCredential } from "../config/resolve.js";
import {
  DEFAULT_QUERY_COST_CEILING_USD,
  DEFAULT_RERANKING_STAGE_BUDGET_MS,
  MAX_ATTEMPTS_PER_STAGE,
  RETRY_BACKOFF_BASE_MS,
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
  selfContainedStageRuntime,
  type StageRuntime,
} from "../core/search-budget.js";
import {
  reviewedProviderPricing,
  type ProviderPricingSource,
} from "../core/pricing.js";
import {
  admitRerankRequest,
  estimateWorstCaseAttemptCostUsd,
  PayloadLimitExceededError,
} from "./admission.js";
import {
  ClassifiedAttemptError,
  defaultRerankTransport,
  executeCohereAttempt,
  classifyFailure,
  type RerankTransport,
} from "./cohere.js";

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
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function identityOf(entry: HybridQueryResult): string {
  return `${entry.file}\u0000${entry.docid}`;
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

interface CandidateAssembly {
  documents: Array<{ identity: string; poolIndex: number; chunk: string }>;
}

/**
 * Assembles the production reranking payload: every candidate stays a
 * distinct entry (identical chunks included) and sends only its exact
 * non-empty QMD-selected chunk. Entries without a usable selected chunk
 * cannot be sent at all; they keep their position score and stay out of the
 * request.
 */
export function assembleCandidates(
  pool: HybridQueryResult[],
): CandidateAssembly {
  const documents: CandidateAssembly["documents"] = [];
  pool.forEach((entry, poolIndex) => {
    const chunk = entry.bestChunk;
    if (typeof chunk !== "string" || chunk.trim() === "") return;
    documents.push({ identity: identityOf(entry), poolIndex, chunk });
  });
  return { documents };
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
  const transport = deps.transport ?? defaultRerankTransport;
  const pricing = deps.pricing ?? reviewedProviderPricing;
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? DEFAULT_SLEEP;
  // Without an orchestrator-provided runtime the stage is self-contained:
  // fresh stage budget and query ceiling, no global deadline.
  const rt = runtime ?? selfContainedStageRuntime(clock, DEFAULT_RERANKING_STAGE_BUDGET_MS);

  let attempts = 0;
  let chargedUsd = 0;
  const metadata = (): RemoteStageMetadata => ({
    attempts,
    retries: Math.max(0, attempts - 1),
    costUsd: Number(chargedUsd.toFixed(6)),
  });

  const degraded = (
    reason: ReasonCode,
    message: string,
    retryable: boolean,
  ): RerankingStageOutcome => ({
    report: { status: "degraded", reason },
    remoteRerankScores: null,
    warning: { stage: "reranking", code: reason, message, retryable },
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
    const admitted = admitRerankRequest(
      buildRerankingQuery(input.originalQuery, input.intent),
      assembly.documents,
    );

    const credential = resolveCredential(route, deps.env ?? process.env);
    const rate = pricing.rateFor(route.provider, route.model);

    let lastFailure: ClassifiedAttemptError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_STAGE; attempt++) {
      // Cancellation first: once the hard end-to-end deadline has passed the
      // stage is cancelled, never completed with a late transmission.
      if (rt.globalExpired()) {
        return degraded(
          "global_deadline_exceeded",
          "The hard end-to-end search deadline expired; the reranking stage was cancelled. Kept QMD fused order.",
          false,
        );
      }
      if (rt.remainingStageMs() <= 0) {
        return degraded(
          "stage_budget_exceeded",
          "The cumulative reranking budget was exhausted before transmission. Kept QMD fused order.",
          false,
        );
      }
      // Cost admission before every attempt: no attempt may be sent unless
      // its worst-case billable cost fits the remaining query ceiling. The
      // estimate is reserved against the orchestrator's cumulative ledger.
      const attemptCostUsd = estimateWorstCaseAttemptCostUsd(admitted, rate);
      if (!rt.reserveAttemptCost(attemptCostUsd)) {
        return degraded(
          "cost_budget_exceeded",
          `Estimated worst-case reranking cost would exceed the US$${DEFAULT_QUERY_COST_CEILING_USD.toFixed(2)} query cost budget. Kept QMD fused order.`,
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
        RERANK_ATTEMPT_TIMEOUT_CAP_MS,
      );
      try {
        const scores = await executeCohereAttempt(
          route,
          credential,
          admitted,
          transport,
          timeoutMs,
        );
        const remoteRerankScores = new Map<HybridQueryResult, number>();
        for (const doc of admitted.documents) {
          const entry = input.pool[doc.poolIndex]!;
          remoteRerankScores.set(entry, scores[doc.index]!);
        }
        return {
          report: { status: "ok", reason: null },
          remoteRerankScores,
          warning: null,
          metadata: metadata(),
        };
      } catch (error) {
        if (!(error instanceof ClassifiedAttemptError)) {
          throw internalError("The reranking adapter failed unexpectedly.", error);
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
      }
    }

    const classification = lastFailure!.classification;
    return degraded(
      classification.reason,
      `Reranking failed after ${MAX_ATTEMPTS_PER_STAGE} attempts (${classification.detail}). Kept QMD fused order.`,
      classification.retryable,
    );
  } catch (error) {
    if (error instanceof PayloadLimitExceededError) {
      return degraded(error.reason, `${error.message} Kept QMD fused order.`, false);
    }
    if (error instanceof QmdxError) throw error;
    const failure = classifyFailure(error, null);
    return degraded(failure.reason, `Reranking failed (${failure.detail}). Kept QMD fused order.`, failure.retryable);
  }
}
