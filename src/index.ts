export * from "./core/enums.js";
export * from "./core/envelope.js";
export * from "./core/errors.js";
export * from "./core/exit-codes.js";
export { systemClock, manualClock, type Clock } from "./core/clock.js";
export {
  reviewedProviderPricing,
  type ProviderPricingSource,
  type RateCardEntry,
} from "./core/pricing.js";
export {
  qmdPositionScore,
  blendedFinalScore,
  retrievalWeightForRank,
} from "./pipeline/score.js";
export { runQuery, submissionRoutes, type QueryRequest } from "./pipeline/search.js";
export {
  DEFAULT_EXPANSION_STAGE_BUDGET_MS,
  DEFAULT_QUERY_COST_CEILING_USD,
  DEFAULT_RERANKING_STAGE_BUDGET_MS,
  EXPANSION_ATTEMPT_TIMEOUT_CAP_MS,
  HARD_END_TO_END_DEADLINE_MS,
  MAX_ATTEMPTS_PER_STAGE,
  RETRY_BACKOFF_BASE_MS,
  RERANK_ATTEMPT_TIMEOUT_CAP_MS,
} from "./core/budgets.js";
export {
  MAX_EXPANSION_INPUT_CHARS,
  ExpansionInputError,
  admitExpansionInput,
  conservativeTokenUpperBound,
  estimateExpansionAttemptShape,
  estimateWorstCaseAttemptCostUsd,
} from "./expand/admission.js";
export {
  EXPANSION_RESPONSE_JSON_SCHEMA,
  EXPANSION_SAMPLING,
  EXPANSION_SCHEMA_NAME,
  EXPANSION_SYSTEM_PROMPT,
} from "./expand/schema.js";
export {
  MAX_COUNT_BY_TYPE,
  MAX_LENGTH_BY_TYPE,
  validateEntry,
  validateGeneratedQueries,
} from "./expand/validate.js";
export {
  ATTEMPT_TIMEOUT_ERROR_NAME as EXPANSION_ATTEMPT_TIMEOUT_ERROR_NAME,
  buildExpansionRequest,
  classifyFailure as classifyExpansionFailure,
  defaultExpandTransport,
  executeExpansionAttempt,
  validateExpansionResponse,
  ClassifiedAttemptError as ExpansionClassifiedAttemptError,
  InvalidProviderResponseError as ExpansionInvalidProviderResponseError,
  type ExpandHttpRequest,
  type ExpandHttpResponse,
  type ExpandTransport,
} from "./expand/openai.js";
export {
  runExpansionStage,
  type ExpansionDeps,
  type ExpansionStageInput,
  type ExpansionStageOutcome,
} from "./expand/stage.js";
export { parseQueryArgs } from "./cli/args.js";
export { runQueryCommand } from "./cli/query-command.js";
export {
  CONFIG_VERSION,
  validateConfig,
  validateProfile,
  type QmdxConfig,
  type RouteProfile,
  type RouteSettings,
} from "./config/schema.js";
export {
  userConfigDir,
  userConfigFilePath,
} from "./config/location.js";
export {
  loadUserConfig,
  saveUserConfig,
  type ConfigStoreOptions,
} from "./config/store.js";
export {
  BUILT_IN_ROUTES,
  loadSelectedRawProfile,
  resolveSelectedProfile,
  resolveCredential,
  routeDiagnostic,
  type EffectiveProfile,
  type EffectiveRoute,
  type RemoteStage,
  type ResolveProfileOptions,
  type RouteCliOverrides,
} from "./config/resolve.js";
export { REQUIRED_EMBED_MODEL } from "./qmd/store.js";
export {
  PREFLIGHT_CAPABILITY_VERSION,
  computeProfilePreflightFingerprint,
  sha256Hex,
  stableStringify,
} from "./preflight/fingerprint.js";
export {
  fingerprintPrivacyDeclaration,
  parsePrivacyDeclaration,
  type PrivacyDeclaration,
} from "./preflight/privacy.js";
export {
  checkCohereCapabilities,
  checkOpenAiCompatibleCapabilities,
  checkRouteCapabilities,
  defaultFetch,
  type FetchLike,
  type StageCapabilityEvidence,
} from "./preflight/capability.js";
export {
  emptyPreflightState,
  loadPreflightState,
  preflightStateFilePath,
  savePreflightState,
  type PreflightStateFile,
  type StoredApproval,
  type StoredLiveCheck,
  type StoredProfilePreflight,
} from "./preflight/state.js";
export {
  NORMAL_LIVE_CHECK_TTL_MS,
  STRICT_LIVE_CHECK_TTL_MS,
  admitRemoteRoutes,
  profileFingerprint,
  recordProfileApproval,
  refreshProfilePreflight,
  reviewedPricingFor,
  type PreflightDeps,
  type ProfilePreflightReport,
  type StagePreflightOutcome,
} from "./preflight/preflight.js";
export {
  APPROVAL_PHRASE,
  obtainExplicitApproval,
} from "./cli/approval.js";
