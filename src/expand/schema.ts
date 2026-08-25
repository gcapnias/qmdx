/**
 * The frozen expansion prompt and strict JSON Schema response format
 * (docs/spec/qmdx-v1.md, "Response"). Provider, endpoint, model, prompt,
 * schema, and parameter versions are part of expansion identity: any change
 * here invalidates preflight fingerprints and approvals downstream.
 */

export const EXPANSION_SCHEMA_NAME = "qmdx_expansion";

/**
 * The strict JSON Schema the provider must satisfy. Plain JSON mode and
 * free-form parsing are ineligible; `strict: true` forces schema-guided
 * decoding. Per-type lengths are enforced locally by validate.ts because a
 * single static schema cannot vary `maxLength` by sibling value.
 */
export const EXPANSION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "queries"],
  properties: {
    outcome: {
      type: "string",
      enum: ["expanded", "original_sufficient"],
    },
    queries: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "query", "language", "purpose"],
        properties: {
          type: { type: "string", enum: ["lex", "vec", "hyde"] },
          query: { type: "string", maxLength: 1200 },
          language: { type: "string", enum: ["en", "el", "und"] },
          purpose: {
            type: "string",
            enum: ["terminology", "translation", "semantic", "hypothetical"],
          },
        },
      },
    },
  },
} as const;

/**
 * The fixed system prompt. It describes only generation rules; it never
 * carries corpus content, retrieved documents, or user data.
 */
export const EXPANSION_SYSTEM_PROMPT = [
  "You generate alternative search queries for a local hybrid (lexical + vector) note search engine.",
  "The user message is the original search query, verbatim. Generate nothing else from anything but that text.",
  'Return an object with "outcome" and "queries".',
  'Use outcome "original_sufficient" with an empty queries array when the original query already covers the likely wording of the target notes.',
  'Otherwise use outcome "expanded" with one to four generated queries.',
  "Each generated query object has: type, query, language, purpose.",
  'type "lex": up to two short keyword variants. purpose must be "terminology" (likely jargon or synonyms of the topic) or "translation" (the same query in its other language). Maximum 256 characters.',
  'type "vec": at most one semantic rewrite phrased as a natural description of what relevant notes would say. purpose must be "semantic". Maximum 512 characters.',
  'type "hyde": at most one hypothetical passage of at most three compact, plausible note-like sentences that answer the query. purpose must be "hypothetical". Maximum 1200 characters.',
  'language is "en" for English output, "el" for Greek output, or "und" only for language-neutral, identifier-heavy output.',
  "Never invent personal facts, citations, filenames, dates, or claims that the user supplied information.",
  "Never repeat the original query unchanged as a generated query.",
  "Generated queries must be self-contained; they are sent without the original query.",
].join("\n");

/** Lowest deterministic sampling settings for the expansion route. */
export const EXPANSION_SAMPLING = {
  temperature: 0,
  topP: 1,
} as const;
