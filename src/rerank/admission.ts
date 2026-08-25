import { invalidProfileConfigError } from "../core/errors.js";
import type { RateCardEntry } from "../core/pricing.js";

/**
 * Provider route admission for the reranking stage: conservative local proof
 * that the complete request fits the provider without splitting, truncation,
 * or silent provider-side truncation (docs/spec/qmdx-v1.md lines 320-331).
 *
 * Nothing in this module performs I/O; it only decides whether a fully
 * assembled payload may be transmitted.
 */

/** Spec cap on reranking candidates submitted in one request. */
export const MAX_RERANK_DOCUMENTS = 80;

/**
 * Provider-validated maximum tokens per document for the reviewed Cohere
 * rerank route. Mirrors the API's `max_tokens_per_doc` validated ceiling;
 * admission never requests more than this.
 */
export const VALIDATED_MAX_TOKENS_PER_DOC = 4_096;

/**
 * Provider-validated maximum aggregate input tokens (query + all documents)
 * for one request on the reviewed Cohere rerank route.
 */
export const VALIDATED_MAX_TOTAL_INPUT_TOKENS = 128_000;

/**
 * Conservative characters-per-token divisor used for the token upper bound.
 * Provider guidance puts typical English near 4 chars/token; multilingual
 * text is denser, so dividing by 3 over-estimates tokens and makes the
 * no-truncation proof conservative.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 3;

/** Fixed per-document tokenizer overhead assumed beyond raw text length. */
export const PER_DOC_TOKEN_OVERHEAD = 8;

/**
 * Conservative upper bound on the tokens a provider tokenizer could report
 * for one piece of text. Deliberately over-counts: it must never be possible
 * for the real token count to exceed this bound.
 */
export function conservativeTokenUpperBound(text: string): number {
  return Math.ceil([...text].length / CONSERVATIVE_CHARS_PER_TOKEN) +
    PER_DOC_TOKEN_OVERHEAD;
}

export interface AdmittedCandidate {
  /** Opaque request index: position of this document in the documents array. */
  index: number;
  /** QMD internal file identity paired with the opaque request index. */
  identity: string;
  /** Index into the QMD candidate pool this candidate came from. */
  poolIndex: number;
  /** Exact non-empty selected chunk transmitted as the document text. */
  chunk: string;
}

export interface AdmittedRerankRequest {
  query: string;
  documents: AdmittedCandidate[];
  /**
   * `max_tokens_per_doc` sent to the provider: high enough for the largest
   * admitted chunk and no higher than the validated maximum.
   */
  maxTokensPerDoc: number;
  /** Conservative upper bound on total input tokens for the request. */
  totalInputTokensUpperBound: number;
}

export class PayloadLimitExceededError extends Error {
  readonly reason = "payload_limit_exceeded" as const;
  constructor(message: string) {
    super(message);
    this.name = "PayloadLimitExceededError";
  }
}

function payloadLimit(detail: string): PayloadLimitExceededError {
  return new PayloadLimitExceededError(detail);
}

/**
 * Validates and admits the complete reranking request before transmission:
 * document count, each selected chunk, per-document and aggregate token
 * limits. Throws {@link PayloadLimitExceededError} when no no-truncation
 * proof is possible.
 */
export function admitRerankRequest(
  query: string,
  documents: Array<{ identity: string; poolIndex: number; chunk: string }>,
): AdmittedRerankRequest {
  if (documents.length === 0) {
    throw payloadLimit("The reranking request contains no documents.");
  }
  if (documents.length > MAX_RERANK_DOCUMENTS) {
    throw payloadLimit(
      `The reranking request has ${documents.length} documents; at most ${MAX_RERANK_DOCUMENTS} may be sent in one request.`,
    );
  }

  let largestChunkTokens = 0;
  let totalDocTokens = 0;
  for (const doc of documents) {
    // The transmitted text must be the exact selected chunk; emptiness is
    // rejected because an empty relevance text proves nothing about rank.
    if (typeof doc.chunk !== "string" || doc.chunk.trim() === "") {
      throw payloadLimit(
        "A reranking candidate has an empty selected chunk; refusing to send it.",
      );
    }
    const tokens = conservativeTokenUpperBound(doc.chunk);
    if (tokens > VALIDATED_MAX_TOKENS_PER_DOC) {
      throw payloadLimit(
        `A selected chunk conservatively bounds at ${tokens} tokens, above the route's validated maximum of ${VALIDATED_MAX_TOKENS_PER_DOC}; no truncation-free transmission can be proven.`,
      );
    }
    largestChunkTokens = Math.max(largestChunkTokens, tokens);
    totalDocTokens += tokens;
  }

  const queryTokens = conservativeTokenUpperBound(query);
  const totalInputTokensUpperBound = queryTokens + totalDocTokens;
  if (totalInputTokensUpperBound > VALIDATED_MAX_TOTAL_INPUT_TOKENS) {
    throw payloadLimit(
      `The reranking request conservatively bounds at ${totalInputTokensUpperBound} input tokens, above the route's validated maximum of ${VALIDATED_MAX_TOTAL_INPUT_TOKENS}.`,
    );
  }

  return {
    query,
    documents: documents.map((doc, index) => ({
      index,
      identity: doc.identity,
      poolIndex: doc.poolIndex,
      chunk: doc.chunk,
    })),
    maxTokensPerDoc: Math.min(largestChunkTokens, VALIDATED_MAX_TOKENS_PER_DOC),
    totalInputTokensUpperBound,
  };
}

/**
 * Conservative worst-case billable cost estimate for one attempt from the
 * admitted payload and the reviewed rate card. Every available billing
 * metric contributes its worst case; the estimate is only ever compared
 * against remaining budgets, never shown as actual spend.
 *
 * Output-token assumption: one score result per document costs at most a few
 * tokens; 8 tokens per result is a generous upper bound.
 */
export function estimateWorstCaseAttemptCostUsd(
  admitted: AdmittedRerankRequest,
  rate: RateCardEntry | null,
): number {
  if (rate === null) {
    throw invalidProfileConfigError(
      "The reranking route has no QMDX-reviewed pricing; cost admission cannot be proven.",
    );
  }
  let usd = 0;
  if (rate.usdPerThousandSearchQueries !== null) {
    usd += rate.usdPerThousandSearchQueries / 1000;
  }
  if (rate.usdPerMillionInputTokens !== null) {
    usd +=
      (admitted.totalInputTokensUpperBound / 1_000_000) *
      rate.usdPerMillionInputTokens;
  }
  if (rate.usdPerMillionOutputTokens !== null) {
    usd += ((admitted.documents.length * 8) / 1_000_000) *
      rate.usdPerMillionOutputTokens;
  }
  return usd;
}
