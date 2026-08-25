import type { CanonicalizationFile, RelevanceGrade } from "./types.js";
import type { SearchResultItem } from "../core/envelope.js";

/**
 * Maps envelope result identities (`docid` or `file`) to canonical document
 * identities using the frozen canonicalization map.
 */
export class AliasIndex {
  private readonly aliasToCanonical = new Map<string, string>();

  constructor(canonicalization: CanonicalizationFile) {
    for (const [canonicalId, entry] of Object.entries(canonicalization.canonicals)) {
      for (const alias of entry.aliases) {
        this.aliasToCanonical.set(alias, canonicalId);
      }
    }
  }

  resolve(result: Pick<SearchResultItem, "docid" | "file">): string | null {
    return this.aliasToCanonical.get(result.docid) ?? this.aliasToCanonical.get(result.file) ?? null;
  }
}

/**
 * Builds a canonical ranking from a pipeline's ordered results: aliases
 * collapse to their best rank and lower results backfill the list to the
 * required number of unique canonical documents.
 */
export function canonicalRanking(
  results: readonly Pick<SearchResultItem, "docid" | "file">[],
  aliases: AliasIndex,
  depth: number,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const canonicalId = aliases.resolve(result);
    if (canonicalId === null || seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    ordered.push(canonicalId);
    if (ordered.length >= depth) break;
  }
  return ordered;
}

export function dcgAt10(grades: readonly RelevanceGrade[]): number {
  let dcg = 0;
  for (let index = 0; index < Math.min(grades.length, 10); index++) {
    const gain = GRAIN_GAINS[grades[index]!]!;
    dcg += gain / Math.log2(index + 2);
  }
  return dcg;
}

/** Grade gains 0, 1, 3, 7 (2^grade - 1). */
export const GRAIN_GAINS: Record<RelevanceGrade, number> = { 0: 0, 1: 1, 2: 3, 3: 7 };

export function ndcgAt10(
  ranking: readonly string[],
  grades: Readonly<Record<string, RelevanceGrade>>,
): number | null {
  const observed = ranking.slice(0, 10).map((canonicalId) => grades[canonicalId] ?? 0);
  const ideal = [...Object.values(grades)].sort((a, b) => b - a);
  const idealDcg = dcgAt10(ideal);
  if (idealDcg <= 0) return null;
  return dcgAt10(observed) / idealDcg;
}
