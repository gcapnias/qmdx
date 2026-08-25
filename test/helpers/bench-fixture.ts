import type {
  BenchmarkManifest,
  CanonicalizationFile,
  JudgmentsFile,
  RelevanceGrade,
} from "../../src/bench/types.js";

export const FIXTURE_QUERY_IDS = [
  ...Array.from({ length: 20 }, (_, index) => `h-${String(index + 1).padStart(2, "0")}`),
];

export function buildValidManifest(
  overrides: Partial<BenchmarkManifest> = {},
): BenchmarkManifest {
  const queries = FIXTURE_QUERY_IDS.map((id) => ({
    id,
    text: `fixture information need ${id}`,
    slice: "headline" as const,
    provenanceRef: `ledger#${id}`,
    intentStatement: `Seeking ${id}`,
    answerabilityAnchorCanonicalId: "c-00",
    ...(id <= "h-02"
      ? { familyId: "graph-engineering" }
      : id <= "h-06"
        ? { familyId: "claude-code" }
        : { familyId: `singleton-${id}` }),
  }));
  return {
    schemaVersion: 1,
    benchmarkId: "qmdx-benchmark-v1",
    seed: 20260825,
    corpus: {
      indexYamlSha256: "a".repeat(64),
      indexSqliteSha256: "b".repeat(64),
    },
    qmdVersion: "2.8.3",
    queries,
    families: [
      { id: "graph-engineering", label: "graph engineering", queryIds: ["h-01", "h-02"] },
      { id: "claude-code", label: "Claude Code", queryIds: ["h-03", "h-04", "h-05", "h-06"] },
      ...FIXTURE_QUERY_IDS.slice(6).map((id) => ({
        id: `singleton-${id}`,
        label: `family ${id}`,
        queryIds: [id],
      })),
    ],
    ...overrides,
  };
}

export function buildValidCanonicalization(): CanonicalizationFile {
  return {
    schemaVersion: 1,
    canonicals: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `c-${String(index).padStart(2, "0")}`,
        { aliases: [`doc-${index}`], representativeFile: `qmd://corpus/doc-${index}.md` },
      ]),
    ),
  };
}

export function buildValidJudgments(): JudgmentsFile {
  const gradePattern: RelevanceGrade[] = [3, 2, 2, 1, 1, 0, 0, 0, 0, 0];
  const grades: JudgmentsFile["grades"] = {};
  for (const queryId of FIXTURE_QUERY_IDS) {
    grades[queryId] = Object.fromEntries(
      gradePattern.map((grade, index) => [`c-${String(index).padStart(2, "0")}`, grade]),
    );
  }
  return {
    schemaVersion: 1,
    rubricVersion: 1,
    adjudicationFrozenAt: "2026-08-25T00:00:00.000Z",
    grades,
  };
}
