import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { EffectiveRoute } from "../config/resolve.js";
import type { ReasonCode } from "../core/enums.js";
import type { AdmittedRerankRequest } from "./admission.js";

/**
 * Cohere reranking adapter: payload construction, response validation,
 * transient-failure classification, and the HTTP transport seam.
 *
 * The adapter never fabricates scores and never splits or truncates a
 * request; admission (admission.ts) must have accepted the payload first.
 */

export interface RerankHttpResponse {
  status: number;
  /** Lower-cased response header names. */
  headers: Record<string, string>;
  json(): Promise<unknown>;
}

export interface RerankHttpRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Wall-clock cap for this attempt; the transport rejects on expiry. */
  timeoutMs: number;
}

export type RerankTransport = (
  url: string,
  init: RerankHttpRequest,
) => Promise<RerankHttpResponse>;

/** Error name used by the default transport when an attempt times out. */
export const ATTEMPT_TIMEOUT_ERROR_NAME = "QmdxAttemptTimeoutError";

/**
 * Default HTTPS POST transport. Uses `agent: false` so no socket outlives
 * the attempt, and destroys the request when `timeoutMs` elapses.
 */
export const defaultRerankTransport: RerankTransport = (url, init) =>
  new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (cause) {
      reject(cause);
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      reject(new Error(`Unsupported endpoint protocol ${target.protocol}`));
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = {
      method: init.method,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: init.headers,
      agent: false,
    };
    const req = send(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: normalizeHeaders(res.headers),
          json: async () => JSON.parse(raw),
        });
      });
    });
    req.setTimeout(init.timeoutMs, () => {
      const timeout = new Error(
        `The reranking attempt exceeded its ${init.timeoutMs} ms timeout.`,
      );
      timeout.name = ATTEMPT_TIMEOUT_ERROR_NAME;
      req.destroy(timeout);
      reject(timeout);
    });
    req.on("error", reject);
    req.write(init.body);
    req.end();
  });

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name.toLowerCase()] = value;
    else if (Array.isArray(value)) normalized[name.toLowerCase()] = value.join(",");
  }
  return normalized;
}

export interface BuiltCohereRequest {
  url: string;
  init: Omit<RerankHttpRequest, "timeoutMs">;
  /**
   * The exact serialized payload; the audit trail proves titles, paths,
   * context, bodies, and retrieval traces stay local.
   */
  serializedBody: string;
}

/** Builds the JSON body for the Cohere v2 rerank endpoint. */
export function buildCohereRequest(
  route: EffectiveRoute,
  credential: string,
  admitted: AdmittedRerankRequest,
): BuiltCohereRequest {
  const serializedBody = JSON.stringify({
    model: route.model,
    query: admitted.query,
    documents: admitted.documents.map((doc) => ({ text: doc.chunk })),
    top_n: admitted.documents.length,
    max_tokens_per_doc: admitted.maxTokensPerDoc,
  });
  return {
    url: `${route.endpoint.replace(/\/+$/, "")}/v2/rerank`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(serializedBody).toString(),
      },
      body: serializedBody,
    },
    get serializedBody() {
      return this.init.body;
    },
  };
}

export class InvalidProviderResponseError extends Error {
  readonly reason = "invalid_provider_response" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderResponseError";
  }
}

/**
 * Validates the complete provider response against the submitted candidates:
 * every candidate exactly once, each with a finite request-local score in
 * [0,1]. Any missing, duplicate, unknown, or invalid entry invalidates the
 * whole response.
 *
 * Returns scores indexed by opaque request index.
 */
export function validateCohereResponse(
  body: unknown,
  expectedCount: number,
): number[] {
  if (body === null || typeof body !== "object") {
    throw new InvalidProviderResponseError("The provider response is not a JSON object.");
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new InvalidProviderResponseError("The provider response has no results array.");
  }
  if (results.length !== expectedCount) {
    throw new InvalidProviderResponseError(
      `The provider returned ${results.length} results for ${expectedCount} candidates.`,
    );
  }
  const scores = new Array<number>(expectedCount).fill(Number.NaN);
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") {
      throw new InvalidProviderResponseError("A provider result entry is not an object.");
    }
    const { index, relevance_score: score } = entry as {
      index?: unknown;
      relevance_score?: unknown;
    };
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedCount
    ) {
      throw new InvalidProviderResponseError(
        "A provider result carries an out-of-range or non-integer document index.",
      );
    }
    if (!Number.isNaN(scores[index])) {
      // Already filled: the same identity came back twice.
      throw new InvalidProviderResponseError(
        `The provider returned duplicate results for document index ${index}.`,
      );
    }
    if (
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new InvalidProviderResponseError(
        `The provider returned a non-finite or out-of-range score for document index ${index}.`,
      );
    }
    scores[index] = score;
  }
  for (let index = 0; index < expectedCount; index++) {
    if (Number.isNaN(scores[index])) {
      throw new InvalidProviderResponseError(
        `The provider returned no result for document index ${index}.`,
      );
    }
  }
  return scores;
}

export interface FailureClassification {
  reason: ReasonCode;
  retryable: boolean;
  /** Provider-suggested wait in milliseconds, when a Retry-After header exists. */
  retryAfterMs: number | null;
  detail: string;
}

/**
 * Classifies one failed attempt. Transient failures (transport error,
 * timeout, HTTP 408/429/5xx, invalid/incomplete response) are retryable at
 * most once; authentication, billing/quota, capability, policy, and local
 * admission rejections are never retried.
 */
export function classifyFailure(
  cause: unknown,
  status: number | null,
): FailureClassification {
  if (status !== null) {
    const retryAfterMs = null;
    const base = { retryAfterMs };
    if (status === 401 || status === 403) {
      return {
        ...base,
        reason: "authentication_failed",
        retryable: false,
        detail: `the provider rejected the credential (HTTP ${status})`,
      };
    }
    if (status === 402) {
      return {
        ...base,
        reason: "billing_or_quota_exhausted",
        retryable: false,
        detail: `billing or quota exhausted at the provider (HTTP ${status})`,
      };
    }
    if (status === 404) {
      return {
        ...base,
        reason: "unsupported_capability",
        retryable: false,
        detail: `the endpoint or model is not available (HTTP ${status})`,
      };
    }
    if (status === 408) {
      return { ...base, reason: "timeout", retryable: true, detail: `attempt timed out (HTTP ${status})` };
    }
    if (status === 429) {
      return { ...base, reason: "rate_limited", retryable: true, detail: `rate limited (HTTP ${status})` };
    }
    if (status >= 500) {
      return {
        ...base,
        reason: "provider_unavailable",
        retryable: true,
        detail: `provider unavailable (HTTP ${status})`,
      };
    }
    return {
      ...base,
      reason: "provider_policy_rejected",
      retryable: false,
      detail: `the provider refused the request (HTTP ${status})`,
    };
  }
  if (cause instanceof Error && cause.name === ATTEMPT_TIMEOUT_ERROR_NAME) {
    return {
      reason: "timeout",
      retryable: true,
      retryAfterMs: null,
      detail: cause.message,
    };
  }
  if (cause instanceof InvalidProviderResponseError) {
    return {
      reason: "invalid_provider_response",
      retryable: true,
      retryAfterMs: null,
      detail: cause.message,
    };
  }
  return {
    reason: "transport_error",
    retryable: true,
    retryAfterMs: null,
    detail:
      cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * Executes exactly one admitted attempt and validates the response.
 * Throws with the failure classification attached; never retries.
 */
export async function executeCohereAttempt(
  route: EffectiveRoute,
  credential: string,
  admitted: AdmittedRerankRequest,
  transport: RerankTransport,
  timeoutMs: number,
): Promise<number[]> {
  const built = buildCohereRequest(route, credential, admitted);
  let response: RerankHttpResponse;
  try {
    response = await transport(built.url, { ...built.init, timeoutMs });
  } catch (cause) {
    throw classifiedError(classifyFailure(cause, null));
  }
  if (response.status < 200 || response.status >= 300) {
    const failure = classifyFailure(null, response.status);
    failure.retryAfterMs = parseRetryAfterMs(response.headers["retry-after"]);
    throw classifiedError(failure);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw classifiedError(
      classifyFailure(
        new InvalidProviderResponseError(
          `the provider response is not valid JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
        null,
      ),
    );
  }
  try {
    return validateCohereResponse(body, admitted.documents.length);
  } catch (cause) {
    throw classifiedError(classifyFailure(cause, null));
  }
}

export class ClassifiedAttemptError extends Error {
  readonly classification: FailureClassification;
  constructor(classification: FailureClassification) {
    super(`Reranking attempt failed: ${classification.detail}`);
    this.name = "ClassifiedAttemptError";
    this.classification = classification;
  }
}

function classifiedError(classification: FailureClassification): ClassifiedAttemptError {
  return new ClassifiedAttemptError(classification);
}

function parseRetryAfterMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1000);
}
