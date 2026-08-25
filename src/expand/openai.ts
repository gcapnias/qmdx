import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { EffectiveRoute } from "../config/resolve.js";
import {
  EXPANSION_RESPONSE_JSON_SCHEMA,
  EXPANSION_SAMPLING,
  EXPANSION_SCHEMA_NAME,
  EXPANSION_SYSTEM_PROMPT,
} from "./schema.js";
import type {
  FailureClassification,
} from "../core/remote-stage.js";
import {
  ClassifiedAttemptError,
} from "../core/remote-stage.js";

export type { FailureClassification };
export { ClassifiedAttemptError };

/**
 * OpenAI-compatible chat-completions expansion adapter: payload
 * construction, strict JSON Schema response validation, transient-failure
 * classification, and the HTTP transport seam.
 *
 * The payload carries ONLY the original query as user content; the fixed
 * system prompt adds generation rules and nothing else. Admission
 * (admission.ts) must have accepted the input first.
 */

export interface ExpandHttpResponse {
  status: number;
  /** Lower-cased response header names. */
  headers: Record<string, string>;
  json(): Promise<unknown>;
}

export interface ExpandHttpRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Wall-clock cap for this attempt; the transport rejects on expiry. */
  timeoutMs: number;
}

export type ExpandTransport = (
  url: string,
  init: ExpandHttpRequest,
) => Promise<ExpandHttpResponse>;

/** Error name used by the default transport when an attempt times out. */
export const ATTEMPT_TIMEOUT_ERROR_NAME = "QmdxAttemptTimeoutError";

/**
 * Default HTTP(S) POST transport. Uses `agent: false` so no socket outlives
 * the attempt, and destroys the request when `timeoutMs` elapses.
 */
export const defaultExpandTransport: ExpandTransport = (url, init) =>
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
        `The expansion attempt exceeded its ${init.timeoutMs} ms timeout.`,
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

export interface BuiltExpansionRequest {
  url: string;
  init: Omit<ExpandHttpRequest, "timeoutMs">;
  /**
   * The exact serialized payload; the audit trail proves only the original
   * query is transmitted as user content.
   */
  serializedBody: string;
}

/** Builds the chat-completions request with a strict JSON Schema response format. */
export function buildExpansionRequest(
  route: EffectiveRoute,
  credential: string,
  originalQuery: string,
): BuiltExpansionRequest {
  const serializedBody = JSON.stringify({
    model: route.model,
    messages: [
      { role: "system", content: EXPANSION_SYSTEM_PROMPT },
      // The original query is the sole sanctioned expansion input.
      { role: "user", content: originalQuery },
    ],
    temperature: EXPANSION_SAMPLING.temperature,
    top_p: EXPANSION_SAMPLING.topP,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: EXPANSION_SCHEMA_NAME,
        strict: true,
        schema: EXPANSION_RESPONSE_JSON_SCHEMA,
      },
    },
  });
  return {
    url: `${route.endpoint.replace(/\/+$/, "")}/chat/completions`,
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

export type ExpansionOutcome = "expanded" | "original_sufficient";

/** Provider-reported token usage for one expansion attempt. */
export interface ExpansionUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ParsedExpansionResponse {
  outcome: ExpansionOutcome;
  /** Raw generated-query entries for local validation. */
  entries: unknown[];
  /** Token usage when the provider response carries a well-typed usage object. */
  usage?: ExpansionUsage;
}

export class InvalidProviderResponseError extends Error {
  readonly reason = "invalid_provider_response" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderResponseError";
  }
}

/**
 * Validates the complete provider response shape: one choice, stopped (not
 * truncated), strict-schema content with a frozen outcome and well-typed
 * entries. Semantic rules (lengths, purposes per type, duplicates, copies)
 * are enforced later by validate.ts over the raw entries.
 */
export function validateExpansionResponse(body: unknown): ParsedExpansionResponse {
  if (body === null || typeof body !== "object") {
    throw new InvalidProviderResponseError("The provider response is not a JSON object.");
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length < 1) {
    throw new InvalidProviderResponseError("The provider response has no choices array.");
  }
  if (choices.length > 1) {
    throw new InvalidProviderResponseError(
      `The provider returned ${choices.length} choices; exactly one was requested.`,
    );
  }
  const choice = choices[0];
  if (choice === null || typeof choice !== "object") {
    throw new InvalidProviderResponseError("The provider choice is not an object.");
  }
  const finishReason = (choice as { finish_reason?: unknown }).finish_reason;
  if (finishReason !== "stop") {
    // "length" means silent truncation; anything else is incomplete output.
    throw new InvalidProviderResponseError(
      `The provider response finished with reason ${JSON.stringify(finishReason)} instead of "stop".`,
    );
  }
  const message = (choice as { message?: unknown }).message;
  if (message === null || typeof message !== "object") {
    throw new InvalidProviderResponseError("The provider choice has no message object.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new InvalidProviderResponseError("The provider message has no text content.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InvalidProviderResponseError(
      "The provider message content is not valid JSON.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidProviderResponseError(
      "The provider message content is not a JSON object.",
    );
  }
  const record = parsed as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome !== "expanded" && outcome !== "original_sufficient") {
    throw new InvalidProviderResponseError(
      'The provider outcome is neither "expanded" nor "original_sufficient".',
    );
  }
  const queries = record.queries;
  if (!Array.isArray(queries)) {
    throw new InvalidProviderResponseError(
      "The provider response has no queries array.",
    );
  }
  for (const entry of queries) {
    assertWellTypedEntry(entry);
  }
  if (outcome === "original_sufficient" && queries.length > 0) {
    throw new InvalidProviderResponseError(
      'The provider declared "original_sufficient" but returned generated queries.',
    );
  }
  return { outcome, entries: queries };
}

/**
 * Extracts provider-reported usage when present and well-typed; diagnostics
 * metadata only — never a substitute for conservative cost admission.
 */
export function extractUsage(
  body: Record<string, unknown>,
): ExpansionUsage | undefined {
  const usage = body.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const reported = usage as Record<string, unknown>;
  const inputTokens =
    typeof reported.prompt_tokens === "number" &&
      Number.isFinite(reported.prompt_tokens)
      ? reported.prompt_tokens
      : undefined;
  const outputTokens =
    typeof reported.completion_tokens === "number" &&
      Number.isFinite(reported.completion_tokens)
      ? reported.completion_tokens
      : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function assertWellTypedEntry(entry: unknown): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new InvalidProviderResponseError(
      "A generated query entry is not an object.",
    );
  }
  const record = entry as Record<string, unknown>;
  for (const field of ["type", "query", "language", "purpose"]) {
    if (typeof record[field] !== "string") {
      throw new InvalidProviderResponseError(
        `A generated query entry has no string "${field}".`,
      );
    }
  }
  // Closed-value enforcement (type, language, purpose, lengths) is a
  // per-entry concern handled by validate.ts so that valid entries survive
  // independently of invalid siblings.
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
    const base = { retryAfterMs: null };
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
 * Executes exactly one admitted attempt and validates the response shape.
 * Throws with the failure classification attached; never retries.
 */
export async function executeExpansionAttempt(
  route: EffectiveRoute,
  credential: string,
  originalQuery: string,
  transport: ExpandTransport,
  timeoutMs: number,
): Promise<ParsedExpansionResponse> {
  const built = buildExpansionRequest(route, credential, originalQuery);
  let response: ExpandHttpResponse;
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
    const parsed = validateExpansionResponse(body);
    // Provider-reported usage rides on the raw response body, outside the
    // strict-schema message content.
    const usage = extractUsage(body as Record<string, unknown>);
    return usage === undefined ? parsed : { ...parsed, usage };
  } catch (cause) {
    throw classifiedError(classifyFailure(cause, null));
  }
}

function classifiedError(classification: FailureClassification): ClassifiedAttemptError {
  return new ClassifiedAttemptError(classification, "Expansion");
}

function parseRetryAfterMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1000);
}
