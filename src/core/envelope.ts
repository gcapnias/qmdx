import type {
  ErrorCategory,
  ErrorCode,
  ErrorStage,
  ExpansionStatus,
  GenerationLanguage,
  GenerationPurpose,
  GeneratedQueryType,
  PipelineStatus,
  ReasonCode,
  RetrievalStatus,
  RerankingStatus,
  WarningStage,
} from "./enums.js";
import { SCHEMA_VERSION } from "./enums.js";

export interface QueryReflection {
  original: string;
  intent: string | null;
  collections: string[];
}

export interface GeneratedQueryDocument {
  type: GeneratedQueryType;
  query: string;
  language: GenerationLanguage;
  purpose: GenerationPurpose;
}

export interface ExpansionStageReport {
  status: ExpansionStatus;
  reason: ReasonCode | null;
  generatedQueries: GeneratedQueryDocument[];
}

export interface RetrievalStageReport {
  status: RetrievalStatus;
  reason: ReasonCode | null;
  candidateCount: number;
  engine: "qmd";
}

export interface RerankingStageReport {
  status: RerankingStatus;
  reason: ReasonCode | null;
  candidateCount: number;
}

export interface PipelineReport {
  status: PipelineStatus;
  expansion: ExpansionStageReport;
  retrieval: RetrievalStageReport;
  reranking: RerankingStageReport;
}

export interface ResultExplanation {
  qmdRrfRank: number;
  qmdPositionWeight: number;
  remoteRerankScore: number | null;
  finalScore: number;
}

export interface SearchResultItem {
  rank: number;
  docid: string;
  score: number;
  file: string;
  title: string;
  context: string | null;
  line: number | null;
  snippet: string | null;
  body?: string;
  explanation?: ResultExplanation;
}

export interface EnvelopeWarning {
  stage: WarningStage;
  code: ReasonCode;
  message: string;
  retryable: boolean;
}

export interface StageTiming {
  total: number;
  expansion: number;
  retrieval: number;
  reranking: number;
  overhead: number;
}

export interface ErrorTiming {
  total: number;
}

export interface ResultEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  query: QueryReflection;
  pipeline: PipelineReport;
  results: SearchResultItem[];
  warnings: EnvelopeWarning[];
  timingMs: StageTiming;
}

export interface ErrorEnvelopeBody {
  category: ErrorCategory;
  code: ErrorCode;
  message: string;
  stage: ErrorStage;
  retryable: boolean;
}

export interface ErrorEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  error: ErrorEnvelopeBody;
  warnings: EnvelopeWarning[];
  timingMs: ErrorTiming;
}

export function buildResultEnvelope(input: {
  query: QueryReflection;
  pipeline: PipelineReport;
  results: SearchResultItem[];
  warnings: EnvelopeWarning[];
  timingMs: StageTiming;
}): ResultEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    query: input.query,
    pipeline: input.pipeline,
    results: input.results,
    warnings: input.warnings,
    timingMs: input.timingMs,
  };
}

export function buildErrorEnvelope(input: {
  error: ErrorEnvelopeBody;
  warnings?: EnvelopeWarning[];
  totalMs: number;
}): ErrorEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    error: input.error,
    warnings: input.warnings ?? [],
    timingMs: { total: input.totalMs },
  };
}
