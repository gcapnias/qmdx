/**
 * Data contracts for the benchmark harness (docs/spec/qmdx-v1.md "Acceptance",
 * lines 697-778). The harness is a development tool: it drives the public CLI
 * as child processes, validates frozen benchmark inputs, and captures
 * controlled evidence. It never emits an accepted/rejected/inconclusive
 * production acceptance outcome; that classification requires live acceptance
 * evidence gathered by a human operator.
 */

export const BENCH_SCHEMA_VERSION = 1;

export type BenchSlice = "headline" | "robustness" | "diagnostic";

export type RelevanceGrade = 0 | 1 | 2 | 3;

export interface ManifestCorpus {
  /** SHA-256 of the frozen QMD index configuration (index.yaml). */
  indexYamlSha256: string;
  /** SHA-256 of the frozen QMD SQLite index snapshot. */
  indexSqliteSha256: string;
  /** Optional SHA-256 over the normalized document tree snapshot. */
  docsTreeSha256?: string;
  /**
   * Optional filesystem root of the document tree, used only to recompute
   * verification hashes at run time.
   */
  docsRoot?: string;
}

export interface BenchQuery {
  id: string;
  text: string;
  slice: BenchSlice;
  /** Topic-family assignment; required for headline queries, forbidden otherwise. */
  familyId?: string;
  /** Reference into the provenance ledger completed before the manifest freeze. */
  provenanceRef: string;
  intentStatement: string;
  answerabilityAnchorCanonicalId?: string;
  /**
   * Disclosed eligibility failure (e.g. unsupported provenance or no pooled
   * canonical document reaching grade 2 after an anchor mismatch). The query
   * keeps its slice assignment, is excluded from the primary aggregate, and
   * remains visible diagnostically.
   */
  eligibilityFailure?: { reason: string } | null;
}

export interface BenchFamily {
  id: string;
  label: string;
  /** Headline query ids belonging to this family. */
  queryIds: string[];
}

export interface BenchmarkManifest {
  schemaVersion: typeof BENCH_SCHEMA_VERSION;
  benchmarkId: string;
  /** Seed for run randomization and the family bootstrap interval. */
  seed: number;
  corpus: ManifestCorpus;
  qmdVersion: string;
  queries: BenchQuery[];
  families: BenchFamily[];
}

export interface CanonicalizationFile {
  schemaVersion: typeof BENCH_SCHEMA_VERSION;
  /**
   * Canonical document identity -> its aliases. An alias is either an envelope
   * `docid` or the envelope `file` identity of one concrete document version.
   */
  canonicals: Record<
    string,
    {
      aliases: string[];
      representativeFile?: string;
      nearDuplicateReview?: "identical-content" | "reviewed-near-duplicate";
    }
  >;
}

export interface JudgmentsFile {
  schemaVersion: typeof BENCH_SCHEMA_VERSION;
  rubricVersion: number;
  adjudicationFrozenAt: string;
  /** query id -> canonical id -> blind relevance grade 0..3. */
  grades: Record<string, Record<string, RelevanceGrade>>;
}

/** The exact frozen candidate configuration recorded before judgments are revealed. */
export interface CandidateFreeze {
  schemaVersion: typeof BENCH_SCHEMA_VERSION;
  benchmarkId: string;
  profileName: string;
  frozenAt: string;
  /** Final output depth used by every variant (`--limit`). */
  outputDepth: number;
  expansion: FrozenRoute;
  reranking: FrozenRoute;
  scoring: {
    formula: "qmd-position-aware-v1";
    rankBands: Array<{ upToRank: number; retrievalWeight: number }>;
  };
  retryPolicy: {
    maxAttemptsPerStage: number;
    hardDeadlineMs: number;
  };
  prompts: {
    expansionSystemPromptSha256: string;
    expansionResponseSchemaSha256: string;
  };
  /** SHA-256 over the stable serialization of everything above. */
  freezeHash: string;
}

export interface FrozenRoute {
  provider: string;
  endpoint: string;
  model: string;
}

export type BenchVariant = "baseline" | "candidate";

export type RunAuthority = "controlled-nonauthoritative" | "live-candidate-package";

export interface RunRecord {
  variant: BenchVariant;
  queryId: string;
  /** Exact public CLI invocation. */
  argv: string[];
  exitCode: number | null;
  wallMs: number;
  window: string;
  repeatIndex: number;
  stdout: string;
  stderr: string;
  resultEnvelope?: unknown;
  errorEnvelope?: unknown;
  /** True when a remote stage reported a persistent-cache hit; such runs are excluded from aggregates. */
  cacheHit: boolean;
  cacheStates: { expansion: string; reranking: string };
}

export interface QueryEvaluation {
  queryId: string;
  eligible: boolean;
  exclusionReason?:
    | "eligibility-failure"
    | "missing-run"
    | "failed-run"
    | "cache-hit"
    | "no-graded-relevant-documents";
  baselineNdcg10?: number;
  candidateNdcg10?: number;
  deltaNdcg10?: number;
  severeRegressionLoss?: boolean;
  baselineTop3UsefulLostInCandidateTop10?: boolean;
  diagnostics: {
    baseline: RankingDiagnostics;
    candidate: RankingDiagnostics;
  };
}

export interface RankingDiagnostics {
  recallAt10: number;
  mrrToFirstGrade2Or3: number;
  successAt3: boolean;
  top10Grades: RelevanceGrade[];
}

export interface GateEvaluation {
  authority: RunAuthority;
  productionOutcome: null;
  productionOutcomeNote: string;
  eligibleQueryCount: number;
  familyWeightedMeanDelta: number | null;
  familiesImproved: number;
  familiesWithEligibleQueries: number;
  magnitudePass: boolean | null;
  majorityPass: boolean | null;
  regressionRate: number | null;
  regressionPass: boolean | null;
  top3AnchorPass: boolean | null;
  bootstrap95: { low: number; high: number } | null;
  operational: {
    latency: GateSummary;
    reliability: GateSummary;
    cost: GateSummary;
  };
  completenessIssues: string[];
  evaluation: "gates-pass" | "gate-fail" | "incomplete-evidence" | "insufficient-evidence";
  gateFailReasons: string[];
}

export interface GateSummary {
  measured: boolean;
  threshold: string;
  value: number | null;
  pass: boolean | null;
  detail?: string;
}
