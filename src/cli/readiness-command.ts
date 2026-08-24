import type { IndexReadinessReport } from "../qmd/readiness.js";
import { validateIndexReadiness } from "../qmd/readiness.js";
import { systemClock } from "../core/clock.js";
import { localIndexUnavailableError, unsupportedOptionError } from "../core/errors.js";
import { findProjectIndex } from "../qmd/paths.js";
import { openProjectStore } from "../qmd/store.js";
import type { CommandIo } from "./failure.js";
import { emitFailure } from "./failure.js";

export type ReadinessCommandName = "setup" | "doctor";

interface ReadinessInvocation {
  format: "human" | "json";
}

function parseReadinessArgs(argv: readonly string[]): ReadinessInvocation {
  const invocation: ReadinessInvocation = { format: "human" };
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
    if (arg === "--profile") {
      throw unsupportedOptionError(arg);
    }
    throw unsupportedOptionError(arg);
  }
  return invocation;
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
    daysStale: number | null;
  };
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
    const report = await validateProjectIndex();

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
