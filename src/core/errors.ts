import type {
  ErrorCategory,
  ErrorCode,
  ErrorStage,
} from "./enums.js";

export class QmdxError extends Error {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly stage: ErrorStage;
  readonly retryable: boolean;

  constructor(
    category: ErrorCategory,
    code: ErrorCode,
    message: string,
    stage: ErrorStage = null,
    retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "QmdxError";
    this.category = category;
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

export function invalidInvocationError(message: string): QmdxError {
  return new QmdxError("invocation", "invalid_invocation", message);
}

export function unsupportedOptionError(option: string): QmdxError {
  return new QmdxError(
    "invocation",
    "unsupported_option",
    `Unsupported option "${option}". Run "qmdx query --help" for supported options.`,
  );
}

export function invalidProfileError(name: string): QmdxError {
  return new QmdxError(
    "configuration",
    "invalid_profile",
    `Route profile "${name}" is not configured.`,
  );
}

export function invalidProfileConfigError(detail: string): QmdxError {
  return new QmdxError("configuration", "invalid_profile", detail);
}

export function missingCredentialsError(
  credentialEnvVar: string,
  stage: "expansion" | "reranking",
): QmdxError {
  return new QmdxError(
    "configuration",
    "missing_credentials",
    `Environment variable "${credentialEnvVar}" (the credential reference for the ${stage} route) is not set.`,
    null,
  );
}

export function localIndexUnavailableError(detail: string): QmdxError {
  return new QmdxError("local_retrieval", "local_index_unavailable", detail);
}

export function localIndexIncompleteError(detail: string): QmdxError {
  return new QmdxError("local_retrieval", "local_index_incomplete", detail);
}

export function vectorProbeFailedError(detail: string): QmdxError {
  return new QmdxError("local_retrieval", "vector_probe_failed", detail);
}

export function requiredRemoteFailedError(
  stage: Exclude<ErrorStage, null>,
  detail: string,
): QmdxError {
  return new QmdxError(
    "required_remote",
    "required_remote_failed",
    detail,
    stage,
    false,
  );
}

export function internalError(message: string, cause?: unknown): QmdxError {
  return new QmdxError(
    "internal",
    "internal_error",
    message,
    null,
    false,
    { cause },
  );
}
