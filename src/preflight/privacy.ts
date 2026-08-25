import { invalidProfileConfigError } from "../core/errors.js";
import { sha256Hex, stableStringify } from "./fingerprint.js";

/**
 * Versioned privacy declaration stored in a profile's `privacy` section as
 * `{ "declaration": { ... } }`. It covers the route's endpoint and region,
 * the payload each remote stage transmits, retention and training terms, and
 * the policy sources that were reviewed when it was written.
 */
export interface PrivacyDeclaration {
  declarationVersion: number;
  endpoint: string;
  region: string;
  stagePayloads: {
    expansion: string;
    reranking: string;
  };
  retention: string;
  trainingUse: string;
  reviewedSources: string[];
}

function nonEmptyString(
  value: unknown,
  context: string,
  field: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidProfileConfigError(
      `${context} privacy declaration field "${field}" must be a non-empty string.`,
    );
  }
  return value;
}

/**
 * Validates the `privacy` section of a route profile and returns its
 * declaration. A missing, malformed, or incomplete declaration is an
 * invalid-profile configuration failure; nothing may be transmitted for
 * such a profile.
 */
export function parsePrivacyDeclaration(
  section: unknown,
  context: string,
): PrivacyDeclaration {
  const label = `${context} privacy`;
  if (
    typeof section !== "object" ||
    section === null ||
    Array.isArray(section)
  ) {
    throw invalidProfileConfigError(
      `${label} section must be a JSON object with a versioned "declaration".`,
    );
  }
  const declaration = (section as Record<string, unknown>).declaration;
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    throw invalidProfileConfigError(
      `${label} section must contain a versioned "declaration" object.`,
    );
  }
  const fields = declaration as Record<string, unknown>;
  const declarationVersion = fields.declarationVersion;
  if (
    typeof declarationVersion !== "number" ||
    !Number.isInteger(declarationVersion) ||
    declarationVersion < 1
  ) {
    throw invalidProfileConfigError(
      `${label} declaration field "declarationVersion" must be a positive integer.`,
    );
  }
  const stagePayloads = fields.stagePayloads;
  if (typeof stagePayloads !== "object" || stagePayloads === null || Array.isArray(stagePayloads)) {
    throw invalidProfileConfigError(
      `${label} declaration field "stagePayloads" must describe the expansion and reranking payloads.`,
    );
  }
  const payloads = stagePayloads as Record<string, unknown>;
  const reviewedSources = fields.reviewedSources;
  if (
    !Array.isArray(reviewedSources) ||
    reviewedSources.length === 0 ||
    reviewedSources.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw invalidProfileConfigError(
      `${label} declaration field "reviewedSources" must list at least one reviewed policy source.`,
    );
  }
  return {
    declarationVersion,
    endpoint: nonEmptyString(fields.endpoint, label, "endpoint"),
    region: nonEmptyString(fields.region, label, "region"),
    stagePayloads: {
      expansion: nonEmptyString(payloads.expansion, label, "stagePayloads.expansion"),
      reranking: nonEmptyString(payloads.reranking, label, "stagePayloads.reranking"),
    },
    retention: nonEmptyString(fields.retention, label, "retention"),
    trainingUse: nonEmptyString(fields.trainingUse, label, "trainingUse"),
    reviewedSources: reviewedSources.map((entry) => (entry as string).trim()),
  };
}

/** Content fingerprint of one declaration; any edit produces a new value. */
export function fingerprintPrivacyDeclaration(
  declaration: PrivacyDeclaration,
): string {
  return sha256Hex(stableStringify(declaration));
}
