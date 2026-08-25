import { join } from "node:path";
import type { EnvelopeWarning, ResultEnvelope } from "../core/envelope.js";
import { systemClock } from "../core/clock.js";
import { parseQueryArgs } from "./args.js";
import {
  admitRemoteRoutesWithContext,
  type AdmittedRouteContext,
} from "../preflight/preflight.js";
import { fingerprintPrivacyDeclaration } from "../preflight/privacy.js";
import {
  CACHE_IDENTITY_VERSION,
  createFileResponseStore,
  parseCachePolicy,
  type StageCacheBinding,
} from "../core/cache.js";
import { userConfigDir } from "../config/location.js";
import { resolveCredential } from "../config/resolve.js";
import {
  activateProtectedDestination,
  CAPTURE_WARNING_MESSAGE,
  createPayloadSink,
  resolveCaptureConfig,
} from "../core/capture.js";
import {
  appendDiagnosticRecord,
  buildDiagnosticRecord,
} from "../core/diagnostics.js";
import type { CommandIo } from "./failure.js";
import { emitFailure } from "./failure.js";
import {
  renderHumanResults,
  renderResultEnvelope,
} from "./render.js";
import { runQuery } from "../pipeline/search.js";
import { RequiredRemoteFailure } from "./required-remote-failure.js";

export type { CommandIo };

/**
 * Opt-in diagnostics destination override. Default operation persists
 * nothing (no-persistence boundary); setting this variable selects the
 * metadata-only diagnostic destination.
 */
const DIAGNOSTICS_DIR_ENV = "QMDX_DIAGNOSTICS_DIR";

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
    const context = admitRemoteRoutesWithContext(invocation.profile, {
      strict: invocation.requireRemote,
    });
    const effectiveProfile = context?.effective ?? null;

    // Explicit warned sensitive-payload capture: warn on stderr before any
    // search work and prepare the protected destination.
    const capture = resolveCaptureConfig(process.env);
    if (capture !== null) {
      streams.stderr.write(`${CAPTURE_WARNING_MESSAGE}\n`);
      activateProtectedDestination(capture);
    }

    const cacheBindings = cacheBindingsFor(context);

    const outcome = await runQuery(invocation, {
      effectiveProfile,
      ...(capture === null ? {} : { capture: createPayloadSink(capture) }),
      ...(cacheBindings.expansion === undefined
        ? {}
        : { expansionCache: cacheBindings.expansion }),
      ...(cacheBindings.reranking === undefined
        ? {}
        : { rerankCache: cacheBindings.reranking }),
    });
    const envelope = outcome.envelope;

    writeDefaultDiagnostics(context, envelope);

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

/**
 * Builds the independently configurable stage caches when (and only when)
 * the selected profile's policy enables them; disabled by default.
 */
function cacheBindingsFor(
  context: AdmittedRouteContext | null,
): { expansion?: StageCacheBinding; reranking?: StageCacheBinding } {
  if (context === null) return {};
  const policy = parseCachePolicy(
    context.policy,
    `profile "${context.effective.name}"`,
  );
  const root = join(
    userConfigDir(),
    "cache",
    `v${CACHE_IDENTITY_VERSION}`,
  );
  const privacyFingerprint = fingerprintPrivacyDeclaration(context.declaration);
  const bindings: { expansion?: StageCacheBinding; reranking?: StageCacheBinding } = {};
  if (policy.expansion.enabled) {
    bindings.expansion = {
      store: createFileResponseStore({
        directory: join(root, "expansion"),
        maxEntries: policy.expansion.maxEntries,
        ttlMs: policy.expansion.ttlSeconds * 1000,
        clock: systemClock,
      }),
      privacyFingerprint,
    };
  }
  if (policy.reranking.enabled) {
    bindings.reranking = {
      store: createFileResponseStore({
        directory: join(root, "reranking"),
        maxEntries: policy.reranking.maxEntries,
        ttlMs: policy.reranking.ttlSeconds * 1000,
        clock: systemClock,
      }),
      privacyFingerprint,
    };
  }
  return bindings;
}

/**
 * Persists the metadata-only diagnostic record when a destination was
 * explicitly selected via QMDX_DIAGNOSTICS_DIR. The record is allowlist
 * projected and every string is redacted against the resolved credential
 * values as the final gate.
 */
function writeDefaultDiagnostics(
  context: AdmittedRouteContext | null,
  envelope: ResultEnvelope,
): void {
  const dir = process.env[DIAGNOSTICS_DIR_ENV];
  if (dir === undefined || dir.trim() === "") return;
  const env = process.env;
  const secretValues: string[] = [];
  if (context !== null) {
    for (const stage of ["expansion", "reranking"] as const) {
      try {
        secretValues.push(resolveCredential(context.effective[stage], env));
      } catch {
        // Unresolved credentials cannot leak.
      }
    }
  }
  appendDiagnosticRecord(
    dir,
    buildDiagnosticRecord({
      envelope,
      profileName: context?.effective.name ?? null,
      expansionRoute: context?.effective.expansion ?? null,
      rerankingRoute: context?.effective.reranking ?? null,
      privacyDeclarationVersion: context?.declaration.declarationVersion ?? null,
      recordedAtMs: systemClock.nowMs(),
    }),
    secretValues,
  );
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

/**
 * Required-remote mode succeeds only when BOTH remote stages returned valid
 * provider results — from an eligible cache entry or a live request alike;
 * both surface as valid pipeline statuses. A degraded stage failed; a
 * disabled stage never produced a provider result, so it also fails the
 * requirement.
 */
function firstFailingRemoteStage(
  envelope: ResultEnvelope,
): "expansion" | "reranking" | null {
  const { expansion, reranking } = envelope.pipeline;
  if (
    expansion.status !== "expanded" &&
    expansion.status !== "original_sufficient"
  ) {
    return "expansion";
  }
  return reranking.status === "ok" ? null : "reranking";
}
