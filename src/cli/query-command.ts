import type { ResultEnvelope } from "../core/envelope.js";
import { systemClock } from "../core/clock.js";
import { parseQueryArgs } from "./args.js";
import { resolveSelectedProfile } from "../config/resolve.js";
import {
  renderErrorEnvelope,
  renderHumanResults,
  renderResultEnvelope,
} from "./render.js";
import { runQuery } from "../pipeline/search.js";
import { RequiredRemoteFailure } from "./required-remote-failure.js";
import { emitFailure } from "./failure.js";

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
    resolveSelectedProfile(invocation.profile);

    const envelope = await runQuery(invocation);

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
      renderHumanResults(streams, envelope);
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
