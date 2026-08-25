import type { HybridQueryResult } from "@tobilu/qmd";

/**
 * Stable internal identity of a candidate pool entry: QMD's internal file
 * URI paired with its opaque document id. Used for deterministic ordering
 * and as the local half of reranking cache identities; never transmitted.
 */
export function identityOf(entry: HybridQueryResult): string {
  return `${entry.file}\u0000${entry.docid}`;
}
