import {
  buildErrorEnvelope,
  type EnvelopeWarning,
  type ErrorEnvelope,
} from "../core/envelope.js";
import { QmdxError } from "../core/errors.js";
import { exitCodeForCategory } from "../core/exit-codes.js";
import { systemClock } from "../core/clock.js";
import type { ResultEnvelope } from "../core/envelope.js";
import { parseQueryArgs } from "./args.js";
import {
  renderErrorEnvelope,
  renderHumanResults,
  renderResultEnvelope,
} from "./render.js";
import { runQuery } from "../pipeline/search.js";

export interface CommandIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function runQueryCommand(
  argv: readonly string[],
  io: CommandIo = process,
): Promise<number> {
  const streams = { stdout: io.stdout, stderr: io.stderr };
  const startedAt = systemClock.nowMs();
  try {
    const invocation = parseQueryArgs(argv);
    if (invocation.profile !== null) {
      throw new QmdxError(
        "configuration",
        "invalid_profile",
        `Route profile "${invocation.profile}" is not configured.`,
      );
    }

    const outcome = await runQuery(invocation);
    const envelope = outcome.envelope;

    if (invocation.requireRemote) {
      const failedStage = firstFailingRemoteStage(envelope);
      if (failedStage !== null) {
        throw new RequiredRemoteFailure(
          `Required remote stage "${failedStage}" did not produce a valid result.`,
          failedStage,
          envelope.warnings,
        );
      }
    }

    if (invocation.format === "json") {
      renderResultEnvelope(streams, envelope);
    } else {
      renderHumanResults(streams, envelope, {
        fullPath: invocation.fullPath,
        lineNumbers: invocation.lineNumbers,
        paths: outcome.resultPaths,
      });
    }
    return 0;
  } catch (error) {
    return emitFailure(error, argv, startedAt, streams);
  }
}

function firstFailingRemoteStage(
  envelope: ResultEnvelope,
): "expansion" | "reranking" | null {
  const { expansion, reranking } = envelope.pipeline;
  if (
    expansion.status === "expanded" ||
    expansion.status === "original_sufficient"
  ) {
    return null;
  }
  if (expansion.status === "degraded") return "expansion";
  if (
    reranking.status === "degraded"
  ) {
    return "reranking";
  }
  return null;
}

class RequiredRemoteFailure extends QmdxError {
  constructor(
    message: string,
    stage: "expansion" | "reranking",
    public readonly stageWarnings: EnvelopeWarning[],
  ) {
    super("required_remote", "required_remote_failed", message, stage);
  }
}

function wantsJsonOutput(argv: readonly string[]): boolean {
  return (
    argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json"
  );
}

function emitFailure(
  error: unknown,
  argv: readonly string[],
  startedAt: number,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): number {
  let qmdxError =
    error instanceof QmdxError
      ? error
      : new QmdxError(
          "internal",
          "internal_error",
          error instanceof Error ? error.message : String(error),
        );
  let warnings: EnvelopeWarning[] | undefined;
  if (error instanceof RequiredRemoteFailure) {
    qmdxError = error;
    warnings = error.stageWarnings;
  }
  const totalMs = systemClock.nowMs() - startedAt;

  if (wantsJsonOutput(argv)) {
    const envelope: ErrorEnvelope = buildErrorEnvelope({
      error: {
        category: qmdxError.category,
        code: qmdxError.code,
        message: qmdxError.message,
        stage: qmdxError.stage,
        retryable: qmdxError.retryable,
      },
      warnings,
      totalMs,
    });
    renderErrorEnvelope(streams, envelope);
  } else {
    streams.stderr.write(`qmdx: ${qmdxError.message}\n`);
  }
  return exitCodeForCategory(qmdxError.category);
}
