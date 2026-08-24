import type { ErrorCategory } from "./enums.js";

export const EXIT_CODES = {
  completed: 0,
  invalidInvocationOrConfiguration: 2,
  localIndexOrRetrievalFailure: 3,
  requiredRemoteInferenceFailure: 4,
  unexpectedInternalFailure: 5,
} as const;

export type ExitCode =
  (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const CATEGORY_EXIT_CODES: Record<ErrorCategory, ExitCode> = {
  invocation: EXIT_CODES.invalidInvocationOrConfiguration,
  configuration: EXIT_CODES.invalidInvocationOrConfiguration,
  local_retrieval: EXIT_CODES.localIndexOrRetrievalFailure,
  required_remote: EXIT_CODES.requiredRemoteInferenceFailure,
  internal: EXIT_CODES.unexpectedInternalFailure,
};

export function exitCodeForCategory(category: ErrorCategory): ExitCode {
  return CATEGORY_EXIT_CODES[category];
}
