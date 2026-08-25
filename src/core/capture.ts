import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { invalidInvocationError } from "./errors.js";

/**
 * Sensitive diagnostic capture (CONTEXT.md; docs/spec/qmdx-v1.md "Caching
 * and diagnostics"): an explicit, warned diagnostic mode that may contain
 * remote payload content at a user-selected protected destination.
 *
 * Activation requires BOTH environment variables:
 * - `QMDX_CAPTURE_DIR`: the user-selected destination directory;
 * - `QMDX_CAPTURE_RETENTION`: one of the closed retention choices.
 *
 * When active, every run prints an explicit warning to stderr before any
 * search work, the destination gets a retention manifest, and all captured
 * files use owner-only permissions. Default operation never captures.
 */

export const CAPTURE_MANIFEST_FILE = "manifest.json";
export const CAPTURE_ENTRY_SCHEMA_VERSION = 1;

/** Closed set of user-selected retention choices recorded in the manifest. */
export const CAPTURE_RETENTION_CHOICES = [
  "session",
  "30d",
  "indefinite",
] as const;

export type CaptureRetention = (typeof CAPTURE_RETENTION_CHOICES)[number];

export interface CaptureConfig {
  dir: string;
  retention: CaptureRetention;
}

/**
 * The explicit warning printed to stderr on every capture-mode run. Human
 * output may use stderr for warnings; JSON envelopes stay clean on stdout.
 */
export const CAPTURE_WARNING_MESSAGE =
  "WARNING: sensitive diagnostic payload capture is ACTIVE for this run. " +
  "Provider requests and responses - including query text and document chunk text - " +
  "will be written to the destination named by QMDX_CAPTURE_DIR. " +
  "Ensure the destination is protected storage you control.";

/**
 * Resolves the capture configuration from the environment. Returns null when
 * capture is not requested (default). Fails closed with an invocation error
 * when partially or invalidly configured.
 */
export function resolveCaptureConfig(
  env: NodeJS.ProcessEnv,
): CaptureConfig | null {
  const dir = env.QMDX_CAPTURE_DIR;
  if (dir === undefined) return null;
  if (dir.trim() === "") {
    throw invalidInvocationError(
      "QMDX_CAPTURE_DIR was set but empty; set it to a protected destination directory.",
    );
  }
  const retention = env.QMDX_CAPTURE_RETENTION;
  if (
    retention === undefined ||
    !(CAPTURE_RETENTION_CHOICES as readonly string[]).includes(retention)
  ) {
    throw invalidInvocationError(
      `QMDX_CAPTURE_RETENTION must be one of ${CAPTURE_RETENTION_CHOICES.map((choice) => `"${choice}"`).join(", ")}.`,
    );
  }
  return { dir, retention: retention as CaptureRetention };
}

/**
 * Prepares the protected destination: owner-only permissions and a retention
 * manifest recording when capture started and which retention was chosen.
 */
export function activateProtectedDestination(config: CaptureConfig): void {
  mkdirSync(config.dir, { recursive: true, mode: 0o700 });
  const manifestPath = join(config.dir, CAPTURE_MANIFEST_FILE);
  if (existsSync(manifestPath)) return;
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: CAPTURE_ENTRY_SCHEMA_VERSION,
        activatedAtMs: Date.now(),
        retention: config.retention,
        warning: CAPTURE_WARNING_MESSAGE,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function redactedHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    copy[name] = name.toLowerCase() === "authorization" ? "[redacted]" : value;
  }
  return copy;
}

/**
 * A sink that records complete provider exchanges (request body and URL,
 * response status and parsed body, or the thrown failure) as individual
 * owner-only JSON files inside the protected destination.
 */
export interface PayloadSink {
  recordRequest(stage: string, url: string, init: {
    method?: string;
    headers?: Record<string, unknown>;
    body?: unknown;
  }): void;
  recordResponse(stage: string, url: string, status: number, body: unknown): void;
  recordFailure(stage: string, url: string, error: unknown): void;
}

export function createPayloadSink(config: CaptureConfig): PayloadSink {
  const writeEntry = (entry: Record<string, unknown>): void => {
    const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`;
    writeFileSync(join(config.dir, name), `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
  return {
    recordRequest(stage, url, init) {
      writeEntry({
        schemaVersion: CAPTURE_ENTRY_SCHEMA_VERSION,
        kind: "request",
        stage,
        capturedAtMs: Date.now(),
        url,
        method: init.method ?? null,
        headers: redactedHeaders(init.headers ?? {}),
        body: typeof init.body === "string" ? safeJson(init.body) : init.body ?? null,
      });
    },
    recordResponse(stage, url, status, body) {
      writeEntry({
        schemaVersion: CAPTURE_ENTRY_SCHEMA_VERSION,
        kind: "response",
        stage,
        capturedAtMs: Date.now(),
        url,
        status,
        body,
      });
    },
    recordFailure(stage, url, error) {
      writeEntry({
        schemaVersion: CAPTURE_ENTRY_SCHEMA_VERSION,
        kind: "failure",
        stage,
        capturedAtMs: Date.now(),
        url,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
      });
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface TransportLike<
  TInit extends { method?: string; headers?: Record<string, unknown>; body?: string },
  TResponse extends { status: number; json(): Promise<unknown> },
> {
  (url: string, init: TInit): Promise<TResponse>;
}

/**
 * Wraps a stage transport so every attempt's exchange is captured into the
 * sink BEFORE transmission (failures included). Credentials are stripped
 * from captured headers; bodies are captured in full by design — this is the
 * explicitly warned protected workflow.
 */
export function captureWrapTransport<
  TInit extends { method?: string; headers?: Record<string, unknown>; body?: string },
  TResponse extends { status: number; json(): Promise<unknown> },
>(
  transport: TransportLike<TInit, TResponse>,
  sink: PayloadSink,
  stage: string,
): TransportLike<TInit, TResponse> {
  return (async (url: string, init: TInit) => {
    sink.recordRequest(stage, url, init);
    try {
      const response = await transport(url, init);
      let body: unknown = "[unreadable response body]";
      try {
        body = await response.json();
      } catch {
        // Keep the placeholder.
      }
      sink.recordResponse(stage, url, response.status, body);
      return response;
    } catch (error) {
      sink.recordFailure(stage, url, error);
      throw error;
    }
  }) as TransportLike<TInit, TResponse>;
}
