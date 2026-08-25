import { GENERATION_PURPOSES_BY_TYPE } from "../core/enums.js";
import type {
  GenerationLanguage,
  GenerationPurpose,
  GeneratedQueryType,
} from "../core/enums.js";
import type { GeneratedQueryDocument } from "../core/envelope.js";

/**
 * Local validation and canonical ordering of provider-generated expansion
 * entries (docs/spec/qmdx-v1.md, "Validation and ordering"). Entries are
 * validated independently: one invalid entry never invalidates its
 * siblings, and partial valid expansion succeeds without a retry.
 */

/** Per-type maximum generated-query length in Unicode characters. */
export const MAX_LENGTH_BY_TYPE: Record<GeneratedQueryType, number> = {
  lex: 256,
  vec: 512,
  hyde: 1200,
};

/** Spec cap on surviving generated queries per type. */
export const MAX_COUNT_BY_TYPE: Record<GeneratedQueryType, number> = {
  lex: 2,
  vec: 1,
  hyde: 1,
};

/** Control characters that survive whitespace normalization invalidate an entry. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface ValidatedExpansion {
  /** Surviving generated queries in canonical submission order. */
  queries: GeneratedQueryDocument[];
  /** Number of discarded entries; counts only, never entry text. */
  discardedCount: number;
}

interface RawEntry {
  type: unknown;
  query: unknown;
  language: unknown;
  purpose: unknown;
}

function isGenerationPurpose(
  type: GeneratedQueryType,
  purpose: string,
): purpose is GenerationPurpose {
  return (GENERATION_PURPOSES_BY_TYPE[type] as readonly string[]).includes(
    purpose,
  );
}

/**
 * Normalizes surrounding and internal whitespace, then validates one entry
 * against the closed type/purpose/language, length, control-character, and
 * content rules. Returns null when the entry must be discarded.
 */
export function validateEntry(
  entry: RawEntry,
): GeneratedQueryDocument | null {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.type !== "string" ||
    typeof entry.query !== "string" ||
    typeof entry.language !== "string" ||
    typeof entry.purpose !== "string"
  ) {
    return null;
  }
  const type = entry.type as GeneratedQueryType;
  if (!(type in MAX_LENGTH_BY_TYPE)) return null;
  if (!isGenerationPurpose(type, entry.purpose)) return null;
  if (!["en", "el", "und"].includes(entry.language)) return null;

  // Normalize surrounding and internal whitespace.
  const query = entry.query.replace(/\s+/g, " ").trim();
  if (query === "") return null;
  if (CONTROL_CHARACTER.test(query)) return null;
  if ([...query].length > MAX_LENGTH_BY_TYPE[type]) return null;

  return {
    type,
    query,
    language: entry.language as GenerationLanguage,
    purpose: entry.purpose,
  };
}

function canonicalRank(query: GeneratedQueryDocument): number {
  switch (`${query.type}:${query.purpose}`) {
    case "lex:terminology":
      return 0;
    case "lex:translation":
      return 1;
    case "vec:semantic":
      return 2;
    default:
      return 3;
  }
}

/**
 * Validates every returned entry independently, removes case-insensitive
 * duplicates within a type, removes generated copies of the corresponding
 * original route, enforces per-type count limits, and orders the survivors
 * canonically: terminology lexical, translation lexical, vector, HyDE.
 */
export function validateGeneratedQueries(
  entries: readonly unknown[],
  originalQuery: string,
): ValidatedExpansion {
  const originalKey = originalQuery.replace(/\s+/g, " ").trim().toLowerCase();
  let discardedCount = 0;
  const valid: GeneratedQueryDocument[] = [];
  const seenKeysByType = new Map<GeneratedQueryType, Set<string>>();

  for (const raw of entries) {
    const entry = validateEntry((raw ?? {}) as RawEntry);
    if (entry === null) {
      discardedCount++;
      continue;
    }
    const key = entry.query.toLowerCase();
    if ((entry.type === "lex" || entry.type === "vec") && key === originalKey) {
      // A generated copy of the corresponding original route adds nothing.
      discardedCount++;
      continue;
    }
    let seen = seenKeysByType.get(entry.type);
    if (seen === undefined) {
      seen = new Set<string>();
      seenKeysByType.set(entry.type, seen);
    }
    if (seen.has(key)) {
      discardedCount++;
      continue;
    }
    seen.add(key);
    valid.push(entry);
  }

  // Enforce count limits after canonical ordering so the highest-priority
  // variants survive.
  const ordered = [...valid].sort((a, b) => canonicalRank(a) - canonicalRank(b));
  const keptByType: Record<GeneratedQueryType, number> = {
    lex: 0,
    vec: 0,
    hyde: 0,
  };
  const queries: GeneratedQueryDocument[] = [];
  for (const entry of ordered) {
    if (keptByType[entry.type] >= MAX_COUNT_BY_TYPE[entry.type]) {
      discardedCount++;
      continue;
    }
    keptByType[entry.type]++;
    queries.push(entry);
  }

  return { queries, discardedCount };
}
