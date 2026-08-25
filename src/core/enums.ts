export const SCHEMA_VERSION = 1;

export const PIPELINE_STATUSES = ["ok", "degraded"] as const;
export const EXPANSION_STATUSES = [
  "expanded",
  "original_sufficient",
  "degraded",
  "disabled",
] as const;
export const RERANKING_STATUSES = ["ok", "degraded", "disabled"] as const;

export const WARNING_STAGES = ["expansion", "reranking"] as const;

export const REASON_CODES = [
  "transport_error",
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "authentication_failed",
  "billing_or_quota_exhausted",
  "provider_policy_rejected",
  "unsupported_capability",
  "invalid_provider_response",
  "payload_limit_exceeded",
  "cost_budget_exceeded",
  "stage_budget_exceeded",
  "global_deadline_exceeded",
] as const;

export const ERROR_CATEGORIES = [
  "invocation",
  "configuration",
  "local_retrieval",
  "required_remote",
  "internal",
] as const;

export const ERROR_CODES = [
  "invalid_invocation",
  "unsupported_option",
  "invalid_profile",
  "missing_credentials",
  "preflight_required",
  "privacy_approval_required",
  "local_index_unavailable",
  "local_index_incomplete",
  "vector_probe_failed",
  "required_remote_failed",
  "internal_error",
] as const;

export const GENERATED_QUERY_TYPES = ["lex", "vec", "hyde"] as const;
export const GENERATION_LANGUAGES = ["en", "el", "und"] as const;
export const GENERATION_PURPOSES_BY_TYPE = {
  lex: ["terminology", "translation"],
  vec: ["semantic"],
  hyde: ["hypothetical"],
} as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export type ExpansionStatus = (typeof EXPANSION_STATUSES)[number];
export type RerankingStatus = (typeof RERANKING_STATUSES)[number];
export type WarningStage = (typeof WARNING_STAGES)[number];
export type ReasonCode = (typeof REASON_CODES)[number];
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorStage = WarningStage | "retrieval" | null;
export type GeneratedQueryType = (typeof GENERATED_QUERY_TYPES)[number];
export type GenerationLanguage = (typeof GENERATION_LANGUAGES)[number];
export type GenerationPurpose =
  | "terminology"
  | "translation"
  | "semantic"
  | "hypothetical";
