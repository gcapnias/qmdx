import type { IndexReadinessReport } from "../qmd/readiness.js";
import { validateIndexReadiness } from "../qmd/readiness.js";
import { systemClock } from "../core/clock.js";
import { invalidInvocationError, localIndexUnavailableError, unsupportedOptionError } from "../core/errors.js";
import {
  resolveSelectedProfile,
  routeDiagnostic,
  type EffectiveProfile,
} from "../config/resolve.js";
import {
  refreshProfilePreflight,
  type ProfilePreflightReport,
} from "../preflight/preflight.js";
import { obtainExplicitApproval } from "./approval.js";
import { findProjectIndex } from "../qmd/paths.js";
import { openProjectStore } from "../qmd/store.js";
import type { CommandIo } from "./failure.js";
import { emitFailure } from "./failure.js";

export type ReadinessCommandName = "setup" | "doctor";

interface ReadinessInvocation {
  format: "human" | "json";
  profile: string | null;
}

function parseReadinessArgs(argv: readonly string[]): ReadinessInvocation {
  const invocation: ReadinessInvocation = { format: "human", profile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (value !== "json" && value !== "human") {
        throw unsupportedOptionError(arg);
      }
      invocation.format = value;
      continue;
    }
    if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "json" && value !== "human") {
        throw unsupportedOptionError("--format");
      }
      invocation.format = value;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const value = arg.startsWith("--profile=")
        ? arg.slice("--profile=".length)
        : argv[++i];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw invalidInvocationError(`Option ${arg} requires a value.`);
      }
      invocation.profile = value;
      continue;
    }
    throw unsupportedOptionError(arg);
  }
  return invocation;
}

export interface RoutePreflightDiagnostics {
  profile: string;
  fingerprint: string;
  privacy: {
    declarationVersion: number;
    endpoint: string;
    region: string;
    retention: string;
    trainingUse: string;
  };
  approval: { current: boolean };
  stages: Record<
    "expansion" | "reranking",
    { reused: boolean; checkedAtMs: number; modelListed: boolean }
  >;
}

export interface ReadinessDiagnostics {
  schemaVersion: 1;
  command: ReadinessCommandName;
  status: "ok";
  index: {
    embedModel: string;
    multilingualProfile: boolean;
    totalDocuments: number;
    needsEmbedding: number;
    incompletePercent: number;
    hasVectorIndex: boolean;
    vectorProbeResults: number;
    daysStale: null | number;
  };
  routes?: RoutePreflightDiagnostics;
  warnings: Array<{ code: string; message: string }>;
  timingMs: { total: number };
}

export async function runReadinessCommand(
  command: ReadinessCommandName,
  argv: readonly string[],
  io: CommandIo = process,
): Promise<number> {
  const streams = { stdout: io.stdout, stderr: io.stderr };
  const startedAt = systemClock.nowMs();
  try {
    const invocation = parseReadinessArgs(argv);
    const effectiveProfile: EffectiveProfile | null =
      resolveSelectedProfile(invocation.profile);
    if (
      invocation.format === "human" &&
      effectiveProfile !== null
    ) {
      for (const stage of ["expansion", "reranking"] as const) {
        const route = routeDiagnostic(effectiveProfile[stage]);
        streams.stdout.write(
          `${command} ${stage}: provider=${route.provider} endpoint=${route.endpoint} model=${route.model} credentialEnv=${route.credentialEnv}\n`,
        );
      }
    }
    const report = await validateProjectIndex();
    const routePreflight: ProfilePreflightReport | null =
      effectiveProfile !== null
        ? await refreshProfilePreflight(invocation.profile)
        : null;
    if (routePreflight !== null) {
      if (command === "setup" && !routePreflight.approvalCurrent) {
        await obtainExplicitApproval(
          invocation.profile,
          routePreflight.profile,
          routePreflight.fingerprint,
          routePreflight.declaration,
          streams.stderr,
          { quiet: invocation.format === "json" },
        );
        routePreflight.approvalCurrent = true;
      }
      if (invocation.format === "human") {
        renderRoutePreflight(streams, command, routePreflight);
      }
    }

    if (invocation.format === "json") {
      const diagnostics: ReadinessDiagnostics = {
        schemaVersion: 1,
        command,
        status: "ok",
        index: {
          embedModel: report.embedModel,
          multilingualProfile: report.multilingualDefault,
          totalDocuments: report.totalDocuments,
          needsEmbedding: report.needsEmbedding,
          incompletePercent: report.incompletePercent,
          hasVectorIndex: report.hasVectorIndex,
          vectorProbeResults: report.probeResults,
          daysStale: report.daysStale,
        },
        ...(routePreflight !== null
          ? { routes: routePreflightDiagnostics(routePreflight) }
          : {}),
        warnings: report.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
        })),
        timingMs: { total: systemClock.nowMs() - startedAt },
      };
      streams.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    } else {
      renderHumanReport(streams, command, report);
    }
    return 0;
  } catch (error) {
    return emitFailure(error, argv, startedAt, streams);
  }
}

async function validateProjectIndex(): Promise<IndexReadinessReport> {
  const location = findProjectIndex();
  if (location === null) {
    throw localIndexUnavailableError(
      "No QMD project index found (looked for .qmd/index.yaml upward from the working directory).",
    );
  }
  const opened = await openProjectStore(location);
  try {
    return await validateIndexReadiness(opened);
  } finally {
    opened.store.close();
  }
}

function routePreflightDiagnostics(
  report: ProfilePreflightReport,
): RoutePreflightDiagnostics {
  return {
    profile: report.profile,
    fingerprint: report.fingerprint,
    privacy: {
      declarationVersion: report.declaration.declarationVersion,
      endpoint: report.declaration.endpoint,
      region: report.declaration.region,
      retention: report.declaration.retention,
      trainingUse: report.declaration.trainingUse,
    },
    approval: { current: report.approvalCurrent },
    stages: {
      expansion: {
        reused: report.stages.expansion!.reused,
        checkedAtMs: report.stages.expansion!.checkedAtMs,
        modelListed: report.stages.expansion!.evidence?.modelListed ?? false,
      },
      reranking: {
        reused: report.stages.reranking!.reused,
        checkedAtMs: report.stages.reranking!.checkedAtMs,
        modelListed: report.stages.reranking!.evidence?.modelListed ?? false,
      },
    },
  };
}

function renderRoutePreflight(
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  command: ReadinessCommandName,
  report: ProfilePreflightReport,
): void {
  for (const stage of ["expansion", "reranking"] as const) {
    const outcome = report.stages[stage]!;
    const evidence = outcome.evidence;
    const state = evidence === null
      ? "no capability evidence"
      : `model listed=${evidence.modelListed}`;
    streams.stdout.write(
      `${command} ${stage} live check: ok (${state}, checked ${outcome.reused ? "previously" : "now"})\n`,
    );
  }
  streams.stdout.write(
    `Privacy declaration v${report.declaration.declarationVersion} for profile "${report.profile}" ` +
      `(endpoint ${report.declaration.endpoint}, region ${report.declaration.region}).\n`,
  );
  if (command === "setup") {
    streams.stdout.write(
      report.approvalCurrent
        ? `Privacy approval for profile "${report.profile}" is current.\n`
        : `Privacy approval recorded for profile "${report.profile}".\n`,
    );
  } else if (!report.approvalCurrent) {
    streams.stderr.write(
      `Warning: profile "${report.profile}" has no current privacy approval; searches will fail closed until \`qmdx setup\` approves it.\n`,
    );
  }
}

function renderHumanReport(
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  command: ReadinessCommandName,
  report: IndexReadinessReport,
): void {
  const profileLabel = report.multilingualDefault
    ? `${report.embedModel} (QMDX multilingual default)`
    : `${report.embedModel} (override)`;
  streams.stdout.write(`qmdx ${command}\n`);
  for (const warning of report.warnings) {
    streams.stderr.write(`Warning: ${warning.message}\n`);
  }
  streams.stdout.write(`Embedding profile: ${profileLabel}\n`);
  streams.stdout.write(
    `Documents: ${report.totalDocuments} active, ` +
      `${report.needsEmbedding} needing embedding ` +
      `(${report.incompletePercent}% coverage incomplete)\n`,
  );
  streams.stdout.write(
    `Vector index: ${report.hasVectorIndex ? "present" : "absent"}\n`,
  );
  streams.stdout.write(
    `Vector readiness probe: ${report.probeResults > 0 ? "ok" : "no results"}\n`,
  );
  if (report.daysStale !== null) {
    streams.stdout.write(
      `Staleness: ${report.daysStale} day(s) since the newest active document changed (diagnostic only)\n`,
    );
  }
  streams.stdout.write("Local index is usable.\n");
}
