import type { GeneratedQueryType } from "../core/enums.js";
import {
  invalidInvocationError,
  unsupportedOptionError,
} from "../core/errors.js";

export interface TypedQueryRoute {
  type: GeneratedQueryType;
  query: string;
}

export interface ParsedQueryDocument {
  raw: string;
  plainQuery: string | null;
  routes: TypedQueryRoute[];
  documentIntent: string | null;
}

const TYPED_PREFIX_RE = /^(lex|vec|hyde):\s*/i;
const INTENT_PREFIX_RE = /^intent:\s*/i;
const EXPAND_PREFIX_RE = /^expand:\s*/i;
const SEMANTIC_NEGATION_RE = /(^|\s)-[\w"]/;

/**
 * Parse a QMD 2.8.3 compatible query document.
 *
 * Grammar (mirrors QMD's parseStructuredQuery):
 *   query_document = [ intent_line ] { typed_line } ;
 *   intent_line    = "intent:" text newline ;
 *   typed_line     = ( "lex" | "vec" | "hyde" ) ":" text newline ;
 *
 * A single remaining unprefixed line is a plain query (the future expansion
 * input). Any other shape fails as an invocation error rather than being
 * reinterpreted.
 */
export function parseQueryDocument(raw: string): ParsedQueryDocument {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw invalidInvocationError("query text is required");
  }

  const routes: TypedQueryRoute[] = [];
  let documentIntent: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;

    if (EXPAND_PREFIX_RE.test(line)) {
      throw unsupportedOptionError("expand:");
    }

    if (INTENT_PREFIX_RE.test(line)) {
      if (documentIntent !== null) {
        throw invalidInvocationError(
          `Line ${index + 1}: only one intent: line is allowed per query document.`,
        );
      }
      const text = line.replace(INTENT_PREFIX_RE, "").trim();
      if (!text) {
        throw invalidInvocationError(
          `Line ${index + 1}: intent: must include text.`,
        );
      }
      documentIntent = text;
      continue;
    }

    const match = line.match(TYPED_PREFIX_RE);
    if (match) {
      const type = match[1]!.toLowerCase() as GeneratedQueryType;
      const text = line.slice(match[0].length).trim();
      if (!text) {
        throw invalidInvocationError(
          `Line ${index + 1} (${type}:) must include text.`,
        );
      }
      validateTypedRoute(type, text);
      routes.push({ type, query: text });
      continue;
    }

    if (lines.length === 1) {
      return {
        raw,
        plainQuery: line,
        routes: [],
        documentIntent: null,
      };
    }

    throw invalidInvocationError(
      `Line ${index + 1} is missing a lex:/vec:/hyde:/intent: prefix. Each line in a query document must start with one.`,
    );
  }

  if (documentIntent !== null && routes.length === 0) {
    throw invalidInvocationError(
      "intent: cannot appear alone. Add at least one lex:, vec:, or hyde: line.",
    );
  }

  return {
    raw,
    plainQuery: null,
    routes,
    documentIntent,
  };
}

function validateTypedRoute(type: GeneratedQueryType, text: string): void {
  if (/[\r\n]/.test(text)) {
    throw invalidInvocationError(
      `${type} queries must be a single line. Remove newline characters or split into separate ${type}: lines.`,
    );
  }
  if (type === "lex") {
    const quoteCount = (text.match(/"/g) ?? []).length;
    if (quoteCount % 2 === 1) {
      throw invalidInvocationError(
        'Lex query has an unmatched double quote ("). Add the closing quote or remove it.',
      );
    }
    return;
  }
  if (SEMANTIC_NEGATION_RE.test(text)) {
    throw invalidInvocationError(
      "Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.",
    );
  }
}
