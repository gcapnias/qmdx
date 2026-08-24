import type { EnvelopeWarning, ResultEnvelope } from "../core/envelope.js";
import { systemClock } from "../core/clock.js";
import { parseQueryArgs } from "./args.js";
import { admitRemoteRoutes } from "../preflight/preflight.js";
import type { CommandIo } from "./failure.js";
import { emitFailure } from "./failure.js";
import {
  renderHumanResults,
  renderResultEnvelope,
} from "./render.js";
import { runQuery } from "../pipeline/search.js";
import { RequiredRemoteFailure } from "./required-remote-failure.js";

export type { CommandIo };

export async function runQueryCommand(
  argv: readonly string[],
  io: CommandIo = process,
): Promise<number> {
  const streams = { stdout: io.stdout, stderr: io.stderr };
  const startedAt = systemClock.nowMs();
  try {
    const invocation = parseQueryArgs(argv);
    // Fail closed before any work: a selected profile must carry current
    // approval and live checks, otherwise nothing is transmitted at all.
    admitRemoteRoutes(invocation.profile, {
      strict: invocation.requireRemote,
    });

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
    return emitQueryFailure(error, argv, startedAt, streams);
  }
}

function emitQueryFailure(
  error: unknown,
  argv: readonly string[],
  startedAt: number,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): number {
  let warnings: EnvelopeWarning[] | undefined;
  if (error instanceof RequiredRemoteFailure) {
    warnings = error.stageWarnings;
  }
  return emitFailure(error, argv, startedAt, streams, warnings);
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
