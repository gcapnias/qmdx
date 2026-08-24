import {
  localIndexIncompleteError,
  vectorProbeFailedError,
} from "../core/errors.js";
import type { OpenedProjectStore } from "./store.js";
import { REQUIRED_EMBED_MODEL } from "./store.js";

/**
 * Fixed local-only vector readiness probe input. Never sent anywhere; it
 * exists to prove that the configured embed model, stored vector dimensions,
 * and the native sqlite-vec runtime work together.
 */
export const VECTOR_PROBE_QUERY = "qmdx local vector readiness probe";

const COVERAGE_FAIL_THRESHOLD = 0.1;

export interface IndexReadinessWarning {
  code: "embedding_coverage_incomplete" | "embed_profile_override";
  message: string;
}

export interface IndexReadinessReport {
  embedModel: string;
  multilingualDefault: boolean;
  totalDocuments: number;
  needsEmbedding: number;
  incompletePercent: number;
  hasVectorIndex: boolean;
  probeResults: number;
  /** Days since the newest active document change; diagnostic only. */
  daysStale: number | null;
  warnings: IndexReadinessWarning[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Validate that the opened QMD index is usable for the effective embedding
 * profile, per the spec's local-index contract:
 *
 * 1. fail when there are no active documents;
 * 2. fail when the vector index is absent;
 * 3. fail when more than 10% of active documents need embedding for the
 *    effective model and fingerprint (warn at or below 10% with count+pct);
 * 4. run a fixed local-only searchVector({ limit: 1 }) readiness probe and
 *    fail when it throws or retrieves nothing from an otherwise complete,
 *    non-empty index.
 *
 * Staleness is reported as a diagnostic and never gates usability.
 */
export async function validateIndexReadiness(
  opened: OpenedProjectStore,
): Promise<IndexReadinessReport> {
  const { store } = opened;
  const status = await store.getStatus();

  if (status.totalDocuments === 0) {
    throw localIndexIncompleteError(
      "The QMD index has no active documents. Add documents to a configured collection and run `qmd update`.",
    );
  }

  if (!status.hasVectorIndex) {
    throw localIndexIncompleteError(
      "The QMD index has no vector index. Run `qmd embed` to generate embeddings for the effective profile.",
    );
  }

  const totalDocuments = status.totalDocuments;
  const needsEmbedding = status.needsEmbedding;
  const incompletePercent = round1((needsEmbedding / totalDocuments) * 100);
  const warnings: IndexReadinessWarning[] = [];

  if (!opened.multilingualDefault) {
    warnings.push({
      code: "embed_profile_override",
      message:
        `Embedding profile "${opened.embedModel}" overrides the QMDX multilingual default ` +
        `("${REQUIRED_EMBED_MODEL}"). This forfeits the English/Greek multilingual retrieval ` +
        "guarantee and requires a complete rebuild with `qmd embed -f`.",
    });
  }

  if (needsEmbedding / totalDocuments > COVERAGE_FAIL_THRESHOLD) {
    throw localIndexIncompleteError(
      `Embedding coverage incomplete: ${needsEmbedding} of ${totalDocuments} active documents ` +
        `(${incompletePercent}%) still need embedding for the effective profile. ` +
        "Run `qmd embed` before searching.",
    );
  }

  if (needsEmbedding > 0) {
    warnings.push({
      code: "embedding_coverage_incomplete",
      message:
        `${needsEmbedding} of ${totalDocuments} active documents (${incompletePercent}%) need ` +
        "embedding for the effective profile.",
    });
  }

  let probeResults: number;
  try {
    const results = await store.searchVector(VECTOR_PROBE_QUERY, { limit: 1 });
    probeResults = results.length;
  } catch (cause) {
    throw vectorProbeFailedError(
      `Vector readiness probe failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  if (probeResults === 0 && needsEmbedding === 0) {
    throw vectorProbeFailedError(
      "Vector readiness probe retrieved no results from an otherwise complete, non-empty index.",
    );
  }

  let daysStale: number | null = null;
  try {
    daysStale = (await store.getIndexHealth()).daysStale ?? null;
  } catch {
    daysStale = null;
  }

  return {
    embedModel: opened.embedModel,
    multilingualDefault: opened.multilingualDefault,
    totalDocuments,
    needsEmbedding,
    incompletePercent,
    hasVectorIndex: true,
    probeResults,
    daysStale,
    warnings,
  };
}
