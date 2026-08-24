import {
  buildErrorEnvelope,
  type EnvelopeWarning,
  type ErrorEnvelope,
} from "../core/envelope.js";
import { QmdxError } from "../core/errors.js";
import { exitCodeForCategory } from "../core/exit-codes.js";
import { systemClock } from "../core/clock.js";
import { renderErrorEnvelope } from "./render.js";
import { RequiredRemoteFailure } from "./required-remote-failure.js";

function wantsJsonOutput(argv: readonly string[]): boolean {
  return (
    argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json"
  );
}

export interface FailureStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Shared QmdxError -> error-envelope/human-line emitter. Returns exit code. */
export function emitFailure(
  error: unknown,
  argv: readonly string[],
  startedAt: number,
  streams: FailureStreams,
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

/** Human-only variant for commands without a --format option (setup/doctor). */
export function emitHumanFailure(
  error: unknown,
  streams: FailureStreams,
): number {
  const startedAt = systemClock.nowMs();
  return emitFailure(error, [], startedAt, streams);
}
