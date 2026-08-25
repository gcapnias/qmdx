import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BenchFamily,
  BenchQuery,
  BenchmarkManifest,
  CanonicalizationFile,
  JudgmentsFile,
  RelevanceGrade,
} from "./types.js";
import { BENCH_SCHEMA_VERSION } from "./types.js";

export const MANIFEST_FILE = "manifest.json";
export const JUDGMENTS_FILE = "judgments.json";
export const CANONICALIZATION_FILE = "canonicalization.json";

/** Benchmark v1 governance decision (spec lines 720-723). */
export const FROZEN_FAMILY_COUNT = 16;
export const FROZEN_HEADLINE_QUERY_COUNT = 20;

const MULTI_QUERY_FAMILY_SIZES = [4, 2];

export const MIN_TOP10_JUDGED_CANONICALS = 10;
export const GRADES: readonly RelevanceGrade[] = [0, 1, 2, 3];

export class BenchDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchDataError";
  }
}

function readJsonFile(path: string, expectedShape: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new BenchDataError(
      `Missing required benchmark data file: ${path}\n` +
        `Expected shape:\n${expectedShape}`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BenchDataError(
      `Benchmark data file is not valid JSON: ${path} (${String(error)})`,
    );
  }
}

function assertPlainObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BenchDataError(`${context} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new BenchDataError(message);
}

/**
 * Loads and validates the frozen benchmark inputs from a benchmark directory:
 * the manifest (20 headline queries across exactly the 16 frozen topic
 * families), the canonicalization map, and the blind judgments. Missing or
 * malformed files fail loudly with the expected format — judgments are never
 * fabricated.
 */
export function loadAndValidateBenchInputs(benchDir: string): {
  manifest: BenchmarkManifest;
  canonicalization: CanonicalizationFile;
  judgments: JudgmentsFile;
} {
  const manifest = validateManifest(
    readJsonFile(
      join(benchDir, MANIFEST_FILE),
      '{ "schemaVersion": 1, "benchmarkId": string, "seed": number, "corpus": { indexYamlSha256, indexSqliteSha256 }, "qmdVersion": string, "queries": [ { id, text, slice: "headline"|"robustness"|"diagnostic", familyId?, provenanceRef, intentStatement, answerabilityAnchorCanonicalId?, eligibilityFailure? } ], "families": [ { id, label, queryIds } ] }',
    ),
  );
  const canonicalization = validateCanonicalization(
    readJsonFile(
      join(benchDir, CANONICALIZATION_FILE),
      '{ "schemaVersion": 1, "canonicals": { "<canonicalId>": { "aliases": ["<docid|qmd:// path>"], "representativeFile"? } } }',
    ),
  );
  const judgments = validateJudgments(
    readJsonFile(
      join(benchDir, JUDGMENTS_FILE),
      '{ "schemaVersion": 1, "rubricVersion": 1, "adjudicationFrozenAt": ISO-string, "grades": { "<queryId>": { "<canonicalId>": 0..3 } } }',
    ),
    manifest,
    canonicalization,
  );
  return { manifest, canonicalization, judgments };
}

export function validateManifest(value: unknown): BenchmarkManifest {
  const root = assertPlainObject(value, "manifest");
  if (root["schemaVersion"] !== BENCH_SCHEMA_VERSION) {
    fail(`manifest.schemaVersion must be ${BENCH_SCHEMA_VERSION}.`);
  }
  for (const field of ["benchmarkId", "qmdVersion"] as const) {
    if (typeof root[field] !== "string" || (root[field] as string).trim() === "") {
      fail(`manifest.${field} must be a non-empty string.`);
    }
  }
  if (typeof root["seed"] !== "number" || !Number.isInteger(root["seed"])) {
    fail("manifest.seed must be an integer.");
  }
  const corpus = assertPlainObject(root["corpus"], "manifest.corpus");
  for (const field of ["indexYamlSha256", "indexSqliteSha256"] as const) {
    if (typeof corpus[field] !== "string" || !/^[0-9a-f]{64}$/.test(corpus[field] as string)) {
      fail(`manifest.corpus.${field} must be a lowercase hex SHA-256 digest.`);
    }
  }

  const queriesRaw = root["queries"];
  if (!Array.isArray(queriesRaw) || queriesRaw.length === 0) {
    fail("manifest.queries must be a non-empty array.");
  }
  const queries: BenchQuery[] = queriesRaw.map((entry, index) =>
    validateQuery(entry, `manifest.queries[${index}]`),
  );
  const ids = new Set(queries.map((query) => query.id));
  if (ids.size !== queries.length) {
    fail("manifest.queries contains duplicate ids.");
  }

  const familiesRaw = root["families"];
  if (!Array.isArray(familiesRaw)) {
    fail("manifest.families must be an array.");
  }
  const families: BenchFamily[] = familiesRaw.map((entry, index) => {
    const family = assertPlainObject(entry, `manifest.families[${index}]`);
    if (
      typeof family["id"] !== "string" ||
      typeof family["label"] !== "string" ||
      !Array.isArray(family["queryIds"]) ||
      family["queryIds"].length === 0
    ) {
      fail(
        `manifest.families[${index}] must be { id: string, label: string, queryIds: non-empty string[] }.`,
      );
    }
    return {
      id: family["id"] as string,
      label: family["label"] as string,
      queryIds: family["queryIds"] as string[],
    };
  });

  // Frozen family structure: exactly one two-query graph-engineering family,
  // one four-query Claude Code family, and fourteen singletons. The manifest
  // reproduces these assignments exactly; it does not determine a new family
  // count at execution time.
  if (families.length !== FROZEN_FAMILY_COUNT) {
    fail(
      `manifest.families must contain exactly ${FROZEN_FAMILY_COUNT} frozen topic families (found ${families.length}).`,
    );
  }
  const sizeHistogram = new Map<number, number>();
  for (const family of families) {
    sizeHistogram.set(family.queryIds.length, (sizeHistogram.get(family.queryIds.length) ?? 0) + 1);
    for (const queryId of family.queryIds) {
      if (!ids.has(queryId)) {
        fail(`family "${family.id}" references unknown query id "${queryId}".`);
      }
      const query = queries.find((candidate) => candidate.id === queryId)!;
      if (query.slice !== "headline") {
        fail(`family "${family.id}" references non-headline query "${queryId}".`);
      }
      if (query.familyId !== family.id) {
        fail(
          `query "${queryId}" declares familyId ${JSON.stringify(query.familyId)} but family "${family.id}" lists it.`,
        );
      }
    }
  }
  for (const size of MULTI_QUERY_FAMILY_SIZES) {
    const count = sizeHistogram.get(size) ?? 0;
    if (count !== 1) {
      fail(
        `frozen structure requires exactly one family of ${size} queries (found ${count}); benchmark v1 has one two-query graph-engineering family and one four-query Claude Code family.`,
      );
    }
  }
  const singletons = sizeHistogram.get(1) ?? 0;
  if (singletons !== FROZEN_FAMILY_COUNT - MULTI_QUERY_FAMILY_SIZES.length) {
    fail(
      `frozen structure requires ${FROZEN_FAMILY_COUNT - MULTI_QUERY_FAMILY_SIZES.length} singleton families (found ${singletons}).`,
    );
  }

  const headlineQueries = queries.filter((query) => query.slice === "headline");
  if (headlineQueries.length !== FROZEN_HEADLINE_QUERY_COUNT) {
    fail(
      `frozen workload requires exactly ${FROZEN_HEADLINE_QUERY_COUNT} headline queries (found ${headlineQueries.length}).`,
    );
  }
  const assigned = new Set(families.flatMap((family) => family.queryIds));
  if (assigned.size !== headlineQueries.length) {
    fail(
      `every headline query needs exactly one topic-family assignment (${assigned.size} assigned of ${headlineQueries.length}).`,
    );
  }
  for (const query of queries) {
    if (query.slice === "headline" && query.familyId === undefined) {
      fail(`headline query "${query.id}" is missing its topic-family assignment.`);
    }
    if (query.slice !== "headline" && query.familyId !== undefined) {
      fail(`non-headline query "${query.id}" must not carry a topic-family assignment.`);
    }
  }

  return {
    schemaVersion: BENCH_SCHEMA_VERSION,
    benchmarkId: root["benchmarkId"] as string,
    seed: root["seed"] as number,
    qmdVersion: root["qmdVersion"] as string,
    corpus: {
      indexYamlSha256: corpus["indexYamlSha256"] as string,
      indexSqliteSha256: corpus["indexSqliteSha256"] as string,
      ...(typeof corpus["docsTreeSha256"] === "string"
        ? { docsTreeSha256: corpus["docsTreeSha256"] as string }
        : {}),
      ...(typeof corpus["docsRoot"] === "string"
        ? { docsRoot: corpus["docsRoot"] as string }
        : {}),
    },
    queries,
    families,
  };
}

function validateQuery(value: unknown, context: string): BenchQuery {
  const query = assertPlainObject(value, context);
  for (const field of ["id", "text", "provenanceRef", "intentStatement"] as const) {
    if (typeof query[field] !== "string" || (query[field] as string).trim() === "") {
      fail(`${context}.${field} must be a non-empty string.`);
    }
  }
  const slice = query["slice"];
  if (slice !== "headline" && slice !== "robustness" && slice !== "diagnostic") {
    fail(`${context}.slice must be "headline", "robustness", or "diagnostic".`);
  }
  const result: BenchQuery = {
    id: query["id"] as string,
    text: query["text"] as string,
    slice,
    provenanceRef: query["provenanceRef"] as string,
    intentStatement: query["intentStatement"] as string,
  };
  if (typeof query["familyId"] === "string") {
    result.familyId = query["familyId"] as string;
  }
  if (typeof query["answerabilityAnchorCanonicalId"] === "string") {
    result.answerabilityAnchorCanonicalId = query["answerabilityAnchorCanonicalId"] as string;
  }
  if (query["eligibilityFailure"] !== undefined && query["eligibilityFailure"] !== null) {
    const failure = assertPlainObject(query["eligibilityFailure"], `${context}.eligibilityFailure`);
    if (typeof failure["reason"] !== "string") {
      fail(`${context}.eligibilityFailure.reason must be a string.`);
    }
    result.eligibilityFailure = { reason: failure["reason"] as string };
  }
  return result;
}

export function validateCanonicalization(value: unknown): CanonicalizationFile {
  const root = assertPlainObject(value, "canonicalization");
  if (root["schemaVersion"] !== BENCH_SCHEMA_VERSION) {
    fail(`canonicalization.schemaVersion must be ${BENCH_SCHEMA_VERSION}.`);
  }
  const canonicals = assertPlainObject(root["canonicals"], "canonicalization.canonicals");
  const seenAliases = new Set<string>();
  if (Object.keys(canonicals).length === 0) {
    fail("canonicalization.canonicals must not be empty.");
  }
  for (const [canonicalId, entryValue] of Object.entries(canonicals)) {
    const entry = assertPlainObject(entryValue, `canonicalization.canonicals["${canonicalId}"]`);
    if (!Array.isArray(entry["aliases"]) || entry["aliases"].length === 0) {
      fail(`canonical "${canonicalId}" must list at least one alias.`);
    }
    for (const alias of entry["aliases"] as unknown[]) {
      if (typeof alias !== "string" || alias.trim() === "") {
        fail(`canonical "${canonicalId}" has a non-string alias.`);
      }
      if (seenAliases.has(alias)) {
        fail(`alias "${alias}" appears under more than one canonical document.`);
      }
      seenAliases.add(alias);
    }
  }
  return { schemaVersion: BENCH_SCHEMA_VERSION, canonicals: canonicals as CanonicalizationFile["canonicals"] };
}

export function validateJudgments(
  value: unknown,
  manifest: BenchmarkManifest,
  canonicalization: CanonicalizationFile,
): JudgmentsFile {
  const root = assertPlainObject(value, "judgments");
  if (root["schemaVersion"] !== BENCH_SCHEMA_VERSION) {
    fail(`judgments.schemaVersion must be ${BENCH_SCHEMA_VERSION}.`);
  }
  if (typeof root["rubricVersion"] !== "number") {
    fail("judgments.rubricVersion must be a number.");
  }
  if (typeof root["adjudicationFrozenAt"] !== "string") {
    fail("judgments.adjudicationFrozenAt must be an ISO timestamp string.");
  }
  const gradesRoot = assertPlainObject(root["grades"], "judgments.grades");

  const knownCanonicals = new Set(Object.keys(canonicalization.canonicals));
  for (const query of manifest.queries) {
    if (query.slice !== "headline") continue;
    const queryGradesValue = gradesRoot[query.id];
    if (queryGradesValue === undefined) {
      fail(
        `judgments.grades is missing the frozen canonical judgments for headline query "${query.id}". The harness never fabricates judgments.`,
      );
    }
    const queryGrades = assertPlainObject(queryGradesValue, `judgments.grades["${query.id}"]`);
    if (Object.keys(queryGrades).length < MIN_TOP10_JUDGED_CANONICALS) {
      fail(
        `headline query "${query.id}" has ${Object.keys(queryGrades).length} judged canonical documents; required top-10 evidence demands at least ${MIN_TOP10_JUDGED_CANONICALS}.`,
      );
    }
    for (const [canonicalId, grade] of Object.entries(queryGrades)) {
      if (!knownCanonicals.has(canonicalId)) {
        fail(`judgments.grades["${query.id}"] references unknown canonical id "${canonicalId}".`);
      }
      if (!GRADES.includes(grade as RelevanceGrade)) {
        fail(`judgments.grades["${query.id}"]["${canonicalId}"] must be an integer grade 0..3.`);
      }
    }
    const anchor = query.answerabilityAnchorCanonicalId;
    if (anchor !== undefined && !(anchor in queryGrades)) {
      fail(
        `answerability anchor "${anchor}" of headline query "${query.id}" is missing from its frozen judgments; anchors are injected into the blind judgment package whether or not a pipeline retrieved them.`,
      );
    }
  }
  return {
    schemaVersion: BENCH_SCHEMA_VERSION,
    rubricVersion: root["rubricVersion"] as number,
    adjudicationFrozenAt: root["adjudicationFrozenAt"] as string,
    grades: gradesRoot as JudgmentsFile["grades"],
  };
}
