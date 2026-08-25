import {
  buildErrorEnvelope,
  type EnvelopeWarning,
  type ErrorEnvelope,
} from "../core/envelope.js";
import { QmdxError } from "../core/errors.js";
import { exitCodeForCategory } from "../core/exit-codes.js";
import { systemClock } from "../core/clock.js";
import { renderErrorEnvelope } from "./render.js";

export interface CommandIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function wantsJsonOutput(argv: readonly string[]): boolean {
  return (
    (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json") ||
    argv.includes("--format=json")
  );
}

/** Shared QmdxError -> error-envelope/human-line emitter. Returns exit code. */
export function emitFailure(
  error: unknown,
  argv: readonly string[],
  startedAt: number,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  stageWarnings?: EnvelopeWarning[],
): number {
  const qmdxError =
    error instanceof QmdxError
      ? error
      : new QmdxError(
          "internal",
          "internal_error",
          error instanceof Error ? error.message : String(error),
        );
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
      warnings: stageWarnings,
      totalMs,
    });
    renderErrorEnvelope(streams, envelope);
  } else {
    streams.stderr.write(`qmdx: ${qmdxError.message}\n`);
  }
  return exitCodeForCategory(qmdxError.category);
}
