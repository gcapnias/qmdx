import { invalidProfileConfigError } from "../core/errors.js";
import type { RateCardEntry } from "../core/pricing.js";

/**
 * Local payload and cost admission for the expansion stage. Nothing here
 * performs I/O: it only decides whether an attempt may be transmitted, and
 * what its conservative worst-case billable cost is
 * (docs/spec/qmdx-v1.md, "Query expansion" and "Cost and time").
 */

/** Spec input cap: non-empty original query, at most 2048 Unicode characters. */
export const MAX_EXPANSION_INPUT_CHARS = 2048;

/**
 * Conservative characters-per-token divisor used for token upper bounds.
 * Dividing by 3 over-estimates tokens for typical prose, which keeps the
 * cost proof conservative.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 3;

/** Fixed per-message tokenizer overhead assumed beyond raw text length. */
export const PER_MESSAGE_TOKEN_OVERHEAD = 16;

/**
 * Conservative upper bound on the tokens a provider tokenizer could count
 * for one piece of text. Deliberately over-counts.
 */
export function conservativeTokenUpperBound(text: string): number {
  return Math.ceil([...text].length / CONSERVATIVE_CHARS_PER_TOKEN) +
    PER_MESSAGE_TOKEN_OVERHEAD;
}

export class ExpansionInputError extends Error {
  readonly reason = "payload_limit_exceeded" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExpansionInputError";
  }
}

/**
 * Validates the sole sanctioned expansion input: the original plain query.
 * Empty input and oversized input are rejected locally rather than
 * truncated; nothing is transmitted.
 */
export function admitExpansionInput(plainQuery: string): string {
  if (typeof plainQuery !== "string" || plainQuery.trim() === "") {
    throw new ExpansionInputError(
      "The expansion input (original query) is empty.",
    );
  }
  if ([...plainQuery].length > MAX_EXPANSION_INPUT_CHARS) {
    throw new ExpansionInputError(
      `The expansion input exceeds the maximum of ${MAX_EXPANSION_INPUT_CHARS} Unicode characters; oversized queries are rejected, not truncated.`,
    );
  }
  return plainQuery;
}

/**
 * Synthesizes the largest response the strict schema admits (two lexical
 * variants at their cap, one vector rewrite at its cap, one HyDE passage at
 * its cap, plus structural overhead) so output-token worst case is derived,
 * not guessed.
 */
function maximalResponseText(): string {
  const lex = "x".repeat(256);
  const vec = "y".repeat(512);
  const hyde = "z".repeat(1200);
  return JSON.stringify({
    outcome: "expanded",
    queries: [
      { type: "lex", query: lex, language: "en", purpose: "terminology" },
      { type: "lex", query: lex, language: "el", purpose: "translation" },
      { type: "vec", query: vec, language: "und", purpose: "semantic" },
      { type: "hyde", query: hyde, language: "en", purpose: "hypothetical" },
    ],
  });
}

const MAX_OUTPUT_TOKENS_UPPER_BOUND = conservativeTokenUpperBound(
  maximalResponseText(),
);

export interface ExpansionCostEstimate {
  inputTokensUpperBound: number;
  outputTokensUpperBound: number;
}

/**
 * Conservative worst-case billable shape of one expansion attempt: the full
 * prompt plus the admitted query on input, and the largest schema-valid
 * response on output.
 */
export function estimateExpansionAttemptShape(
  systemPrompt: string,
  admittedQuery: string,
): ExpansionCostEstimate {
  return {
    inputTokensUpperBound:
      conservativeTokenUpperBound(systemPrompt) +
      conservativeTokenUpperBound(admittedQuery),
    outputTokensUpperBound: MAX_OUTPUT_TOKENS_UPPER_BOUND,
  };
}

/**
 * Conservative worst-case billable cost for one expansion attempt from the
 * estimated token bounds and the reviewed rate card. Only ever compared
 * against remaining budgets, never shown as actual spend.
 */
export function estimateWorstCaseAttemptCostUsd(
  shape: ExpansionCostEstimate,
  rate: RateCardEntry | null,
): number {
  if (rate === null) {
    throw invalidProfileConfigError(
      "The expansion route has no QMDX-reviewed pricing; cost admission cannot be proven.",
    );
  }
  let usd = 0;
  if (rate.usdPerMillionInputTokens !== null) {
    usd += (shape.inputTokensUpperBound / 1_000_000) *
      rate.usdPerMillionInputTokens;
  }
  if (rate.usdPerMillionOutputTokens !== null) {
    usd += (shape.outputTokensUpperBound / 1_000_000) *
      rate.usdPerMillionOutputTokens;
  }
  if (rate.usdPerThousandSearchQueries !== null) {
    usd += rate.usdPerThousandSearchQueries / 1000;
  }
  return usd;
}
