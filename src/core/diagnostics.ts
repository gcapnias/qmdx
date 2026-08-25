import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultEnvelope } from "./envelope.js";

/**
 * Default persistent diagnostics (docs/spec/qmdx-v1.md, "Caching and
 * diagnostics"): metadata-only by construction. The record is built by an
 * ALLOWLIST projection of the envelope — query text, intent, generated
 * queries, selected chunks, paths, headers, and provider response bodies are
 * structurally incapable of appearing — and every string is passed through
 * secret-value redaction before persistence.
 *
 * Diagnostics persistence itself is opt-in (default no-persistence); when a
 * destination is selected the records still carry approved metadata only.
 */

export const DIAGNOSTICS_RECORD_SCHEMA_VERSION = 1;

export interface StageDiagnostics {
  status: string;
  reason: string | null;
  attempts: number;
  retries: number;
  costUsd: number;
  cache?: "hit" | "miss";
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface DiagnosticRecord {
  schemaVersion: typeof DIAGNOSTICS_RECORD_SCHEMA_VERSION;
  recordedAtMs: number;
  profile: string | null;
  expansionProvider: string | null;
  expansionModel: string | null;
  rerankingProvider: string | null;
  rerankingModel: string | null;
  privacyDeclarationVersion: number | null;
  pipelineStatus: string;
  expansion: StageDiagnostics & { generatedQueryCount: number };
  retrieval: { status: string; candidateCount: number };
  reranking: StageDiagnostics & { candidateCount: number };
  timingMs: Record<string, number>;
  warnings: Array<{
    stage: string;
    code: string;
    retryable: boolean;
    message: string;
  }>;
}

/** Replaces every occurrence of a secret value with "[redacted]". */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

/**
 * Recursively redacts secret values in strings inside an arbitrary JSON
 * value; used as the final gate before anything is persisted.
 */
export function redactDeep<T>(value: T, secrets: Iterable<string>): T {
  if (typeof value === "string") {
    return redactSecrets(value, secrets) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, secrets)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      copy[key] = redactDeep(entry, secrets);
    }
    return copy as unknown as T;
  }
  return value;
}

function stageMetadataProjection(metadata: {
  status: string;
  reason: string | null;
  attempts: number;
  retries: number;
  costUsd: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  cache?: "hit" | "miss";
}): StageDiagnostics {
  return {
    status: metadata.status,
    reason: metadata.reason,
    attempts: metadata.attempts,
    retries: metadata.retries,
    costUsd: metadata.costUsd,
    ...(metadata.cache === undefined ? {} : { cache: metadata.cache }),
    ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
  };
}

/**
 * Builds one metadata-only diagnostic record from the result envelope.
 * The projection is allowlist-driven: no envelope field is copied unless it
 * appears below, so content can never leak through future envelope additions.
 */
export function buildDiagnosticRecord(input: {
  envelope: ResultEnvelope;
  profileName: string | null;
  expansionRoute: { provider: string; model: string } | null;
  rerankingRoute: { provider: string; model: string } | null;
  privacyDeclarationVersion: number | null;
  recordedAtMs: number;
}): DiagnosticRecord {
  const { envelope } = input;
  return {
    schemaVersion: DIAGNOSTICS_RECORD_SCHEMA_VERSION,
    recordedAtMs: input.recordedAtMs,
    profile: input.profileName,
    expansionProvider: input.expansionRoute?.provider ?? null,
    expansionModel: input.expansionRoute?.model ?? null,
    rerankingProvider: input.rerankingRoute?.provider ?? null,
    rerankingModel: input.rerankingRoute?.model ?? null,
    privacyDeclarationVersion: input.privacyDeclarationVersion,
    pipelineStatus: envelope.pipeline.status,
    expansion: {
      ...stageMetadataProjection({
        ...envelope.pipeline.expansion.metadata,
        status: envelope.pipeline.expansion.status,
        reason: envelope.pipeline.expansion.reason,
      }),
      generatedQueryCount: envelope.pipeline.expansion.generatedQueries.length,
    },
    retrieval: {
      status: envelope.pipeline.retrieval.status,
      candidateCount: envelope.pipeline.retrieval.candidateCount,
    },
    reranking: {
      ...stageMetadataProjection({
        ...envelope.pipeline.reranking.metadata,
        status: envelope.pipeline.reranking.status,
        reason: envelope.pipeline.reranking.reason,
      }),
      candidateCount: envelope.pipeline.reranking.candidateCount,
    },
    timingMs: { ...envelope.timingMs },
    // Warning messages are our own fixed templates, but they pass through
    // redaction with everything else at persistence time.
    warnings: envelope.warnings.map((warning) => ({
      stage: warning.stage,
      code: warning.code,
      retryable: warning.retryable,
      message: warning.message,
    })),
  };
}

/**
 * Appends one record as a JSON line to `<dir>/diagnostics.jsonl`, creating
 * the directory owner-only. The record is redacted once more here so every
 * caller benefits from the final credential gate regardless of construction.
 */
export function appendDiagnosticRecord(
  directory: string,
  record: DiagnosticRecord,
  secretValues: Iterable<string>,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safe = redactDeep(record, secretValues);
  appendFileSync(
    join(directory, "diagnostics.jsonl"),
    `${JSON.stringify(safe)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
