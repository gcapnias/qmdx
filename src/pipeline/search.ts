import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  buildResultEnvelope,
  type EnvelopeWarning,
  type ResultEnvelope,
  type SearchResultItem,
} from "../core/envelope.js";
import { internalError } from "../core/errors.js";
import type { ReasonCode } from "../core/enums.js";import { fetchCandidatePool } from "../qmd/retrieval.js";
import { findProjectIndex } from "../qmd/paths.js";
import { openProjectStore } from "../qmd/store.js";
import {
  DEGRADED_POSITION_WEIGHT,
  qmdPositionScore,
  round6,
} from "./score.js";
import { localIndexUnavailableError } from "../core/errors.js";

export interface QueryRequest {
  originalQuery: string;
  intent: string | null;
  collections: string[];
  limit: number;
  minScore: number | null;
  full: boolean;
  explain: boolean;
  noExpand: boolean;
  noRerank: boolean;
}

export interface SearchDeps {
  clock?: Clock;
}

interface StageTimingCollector {
  expansionMs: number;
  retrievalMs: number;
  rerankingMs: number;
}

const UNCONFIGURED_ROUTE_CODE: ReasonCode = "provider_unavailable";

export async function runQuery(
  request: QueryRequest,
  deps: SearchDeps = {},
): Promise<ResultEnvelope> {
  const clock = deps.clock ?? systemClock;
  const warnings: EnvelopeWarning[] = [];
  const startedAt = clock.nowMs();
  const timing = { expansionMs: 0, retrievalMs: 0, rerankingMs: 0 };

  const expansion = expansionStage(request, warnings, timing, clock);
  const retrieval = await retrievalStage(request, warnings, timing, clock);
  const reranking = rerankingStage(retrieval.pool.length, request, warnings);

  const ordered = shapeResults(
    retrieval.pool,
    request,
    reranking.remoteRerankScores,
  );

  const totalMs = clock.nowMs() - startedAt;
  const stageSum = timing.expansionMs + timing.retrievalMs + timing.rerankingMs;

  return buildResultEnvelope({
    query: {
      original: request.originalQuery,
      intent: request.intent,
      collections: request.collections,
    },
    pipeline: {
      status: overallStatus(expansion.status, reranking.report.status),
      expansion,
      retrieval: {
        status: "ok",
        reason: null,
        candidateCount: retrieval.pool.length,
        engine: "qmd",
      },
      reranking: {
        status: reranking.report.status,
        reason: reranking.report.reason,
        candidateCount: retrieval.pool.length,
      },
    },
    results: ordered,
    warnings,
    timingMs: {
      total: totalMs,
      expansion: timing.expansionMs,
      retrieval: timing.retrievalMs,
      reranking: timing.rerankingMs,
      overhead: Math.max(0, round6(totalMs - stageSum)),
    },
  });
}

function expansionStage(
  request: QueryRequest,
  warnings: EnvelopeWarning[],
  timing: StageTimingCollector,
  clock: Clock,
) {
  const stageStart = clock.nowMs();
  try {
    if (request.noExpand) {
      return {
        status: "disabled" as const,
        reason: null,
        generatedQueries: [],
      };
    }
    warnings.push(unconfiguredWarning("expansion"));
    return {
      status: "degraded" as const,
      reason: UNCONFIGURED_ROUTE_CODE,
      generatedQueries: [],
    };
  } finally {
    timing.expansionMs = clock.nowMs() - stageStart;
  }
}

interface RetrievalOutcome {
  pool: HybridQueryResult[];
}

async function retrievalStage(
  request: QueryRequest,
  _warnings: EnvelopeWarning[],
  timing: StageTimingCollector,
  clock: Clock,
): Promise<RetrievalOutcome> {
  const stageStart = clock.nowMs();
  try {
    const location = findProjectIndex();
    if (location === null) {
      throw localIndexUnavailableError(
        "No QMD project index found (looked for .qmd/index.yaml upward from the working directory).",
      );
    }
    let store: QMDStore | null = null;
    try {
      store = await openProjectStore(location);
      const routes = retrievalRoutes(request);
      const pool = await fetchCandidatePool(store, {
        originalQuery: request.originalQuery,
        intent: request.intent,
        collections: request.collections,
      }, routes);
      return { pool };
    } finally {
      store?.close();
    }
  } finally {
    timing.retrievalMs = clock.nowMs() - stageStart;
  }
}

function retrievalRoutes(request: QueryRequest): ExpandedQuery[] {
  void request;
  return [{ type: "lex", query: request.originalQuery }];
}

function rerankingStage(
  candidateCount: number,
  request: QueryRequest,
  warnings: EnvelopeWarning[],
): {
  report: { status: "ok" | "degraded" | "disabled"; reason: ReasonCode | null };
  remoteRerankScores: Map<HybridQueryResult, number> | null;
} {
  void candidateCount;
  if (request.noRerank) {
    return { report: { status: "disabled", reason: null }, remoteRerankScores: null };
  }
  warnings.push(unconfiguredWarning("reranking"));
  return {
    report: { status: "degraded", reason: UNCONFIGURED_ROUTE_CODE },
    remoteRerankScores: null,
  };
}

function unconfiguredWarning(stage: "expansion" | "reranking"): EnvelopeWarning {
  return {
    stage,
    code: UNCONFIGURED_ROUTE_CODE,
    message:
      stage === "expansion"
        ? "No remote expansion route is configured; kept original query routes."
        : "No remote reranking route is configured; kept QMD fused order.",
    retryable: false,
  };
}

function overallStatus(...statuses: Array<"ok" | "degraded" | "disabled">) {
  return statuses.some((status) => status === "degraded")
    ? ("degraded" as const)
    : ("ok" as const);
}

function shapeResults(
  pool: HybridQueryResult[],
  request: QueryRequest,
  _remoteRerankScores: Map<HybridQueryResult, number> | null,
): SearchResultItem[] {
  const scored = pool.map((entry) => ({
    entry,
    rrfRank: rrfRankOf(entry),
    publicScore: publicScoreFor(entry),
  }));

  scored.sort(
    (a, b) =>
      b.publicScore - a.publicScore ||
      a.rrfRank - b.rrfRank ||
      identityOf(a.entry).localeCompare(identityOf(b.entry)),
  );

  const filtered = request.minScore === null
    ? scored
    : scored.filter((item) => item.publicScore >= request.minScore!);

  return filtered.slice(0, request.limit).map((item, index) => {
    const result: SearchResultItem = {
      rank: index + 1,
      docid: `#${item.entry.docid}`,
      score: item.publicScore,
      file: item.entry.file,
      title: item.entry.title,
      context: item.entry.context ?? null,
      line: item.entry.bestChunkPos ?? null,
      snippet: snippetFor(item.entry),
    };
    if (request.full) {
      result.body = item.entry.body;
    }
    if (request.explain) {
      result.explanation = explanationFor(item.rrfRank, item.publicScore);
    }
    return result;
  });
}

function rrfRankOf(entry: HybridQueryResult): number {
  const rank = entry.explain?.rrf?.rank;
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 1) {
    throw internalError(`QMD did not report an RRF rank for ${entry.file}`);
  }
  return rank;
}

function publicScoreFor(entry: HybridQueryResult): number {
  return qmdPositionScore(rrfRankOf(entry));
}

export function explanationFor(
  qmdRrfRank: number,
  finalScore: number,
): SearchResultItem["explanation"] {
  return {
    qmdRrfRank,
    qmdPositionWeight: DEGRADED_POSITION_WEIGHT,
    remoteRerankScore: null,
    finalScore,
  };
}

function identityOf(entry: HybridQueryResult): string {
  return `${entry.file}\u0000${entry.docid}`;
}

function snippetFor(entry: HybridQueryResult): string | null {
  const chunk = entry.bestChunk;
  if (typeof chunk !== "string" || chunk.trim() === "") return null;
  return chunk.replace(/\s+/g, " ").trim().slice(0, 240);
}
