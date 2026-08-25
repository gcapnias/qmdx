import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  invalidProfileError,
  privacyApprovalRequiredError,
  preflightRequiredError,
} from "../core/errors.js";
import {
  loadSelectedRawProfile,
  resolveCredential,
  resolveSelectedProfile,
  type EffectiveProfile,
  type EffectiveRoute,
  type RemoteStage,
} from "../config/resolve.js";
import {
  reviewedProviderPricing,
  type ProviderPricingSource,
  type RateCardEntry,
} from "../core/pricing.js";
import { checkRouteCapabilities, type FetchLike, type StageCapabilityEvidence } from "./capability.js";
import {
  computeProfilePreflightFingerprint,
  type RouteFingerprintFields,
} from "./fingerprint.js";
import {
  fingerprintPrivacyDeclaration,
  parsePrivacyDeclaration,
  type PrivacyDeclaration,
} from "./privacy.js";
import {
  loadPreflightState,
  savePreflightState,
} from "./state.js";

/** Authenticated live checks are valid for seven days in normal use. */
export const NORMAL_LIVE_CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Required-remote validation and acceptance runs require evidence no older
 * than 24 hours.
 */
export const STRICT_LIVE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

const STAGES: readonly RemoteStage[] = ["expansion", "reranking"];

export interface PreflightDeps {
  clock?: Clock;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  pricing?: ProviderPricingSource;
  /** Overrides the state file path (test seam). */
  statePath?: string;
}

export interface StagePreflightOutcome {
  stage: RemoteStage;
  /** True when a current recorded check was reused instead of re-fetching. */
  reused: boolean;
  checkedAtMs: number;
  evidence: StageCapabilityEvidence | null;
}

export interface ProfilePreflightReport {
  profile: string;
  fingerprint: string;
  declaration: PrivacyDeclaration;
  stages: Record<RemoteStage, StagePreflightOutcome>;
  approvalCurrent: boolean;
}

function routeFingerprintFields(
  route: EffectiveRoute,
): RouteFingerprintFields {
  return {
    provider: route.provider,
    endpoint: route.endpoint,
    model: route.model,
    credentialEnv: route.credentialEnv,
  };
}

export function reviewedPricingFor(
  route: EffectiveRoute,
  pricing: ProviderPricingSource = reviewedProviderPricing,
): RateCardEntry {
  const entry = pricing.rateFor(route.provider, route.model);
  if (entry === null) {
    throw invalidProfileError(
      `The ${route.stage} route has no QMDX-reviewed pricing for provider "${route.provider}" model "${route.model}". Add the model to the reviewed rate card before use.`,
    );
  }
  return entry;
}

export function profileFingerprint(
  effective: EffectiveProfile,
  declaration: PrivacyDeclaration,
  pricing: ProviderPricingSource = reviewedProviderPricing,
): string {
  return computeProfilePreflightFingerprint({
    expansion: routeFingerprintFields(effective.expansion),
    reranking: routeFingerprintFields(effective.reranking),
    expansionPricing: reviewedPricingFor(effective.expansion, pricing),
    rerankingPricing: reviewedPricingFor(effective.reranking, pricing),
    privacyDeclarationFingerprint: fingerprintPrivacyDeclaration(declaration),
  });
}

interface SelectedProfile {
  effective: EffectiveProfile;
  declaration: PrivacyDeclaration;
  fingerprint: string;
  /** The profile's stored non-secret policy section (e.g. cache settings). */
  policy: Record<string, unknown>;
}

function selectProfileForPreflight(
  requestedProfile: string | null | undefined,
  deps: PreflightDeps,
): SelectedProfile | null {
  const env = deps.env ?? process.env;
  const effective = resolveSelectedProfile(requestedProfile, { env });
  if (effective === null) return null;
  const raw = loadSelectedRawProfile(requestedProfile, { env });
  const declaration = parsePrivacyDeclaration(
    raw?.privacy,
    `profile "${effective.name}"`,
  );
  return {
    effective,
    declaration,
    fingerprint: profileFingerprint(effective, declaration, deps.pricing),
    policy: raw?.policy ?? {},
  };
}

function isFresh(checkedAtMs: number, ttlMs: number, clock: Clock): boolean {
  return clock.nowMs() - checkedAtMs < ttlMs;
}

/**
 * Runs authenticated live capability checks for every stage of the selected
 * profile and records the non-secret results. A current recorded check with
 * a matching fingerprint is reused instead of contacting the provider again.
 *
 * Failures throw configuration errors before anything beyond the minimal
 * catalog request is transmitted; no search payload exists on this path.
 */
export async function refreshProfilePreflight(
  requestedProfile: string | null | undefined,
  deps: PreflightDeps = {},
): Promise<ProfilePreflightReport> {
  const selected = selectProfileForPreflight(requestedProfile, deps);
  if (selected === null) {
    throw invalidProfileError("No route profile is configured.");
  }
  const clock = deps.clock ?? systemClock;
  const env = deps.env ?? process.env;
  const statePath = deps.statePath !== undefined
    ? { filePath: deps.statePath }
    : {};
  const state = loadPreflightState(statePath);
  const stored = state.profiles[selected.effective.name] ?? {};
  const stages = {} as Record<RemoteStage, StagePreflightOutcome>;

  for (const stage of STAGES) {
    const route = selected.effective[stage];
    const existing = stored.liveChecks?.[stage];
    if (
      existing !== undefined &&
      existing.fingerprint === selected.fingerprint &&
      isFresh(existing.checkedAtMs, NORMAL_LIVE_CHECK_TTL_MS, clock)
    ) {
      stages[stage] = {
        stage,
        reused: true,
        checkedAtMs: existing.checkedAtMs,
        evidence: existing.evidence,
      };
      continue;
    }
    const credential = resolveCredential(route, env);
    const evidence = await checkRouteCapabilities(
      route,
      credential,
      deps.fetchImpl,
    );
    stages[stage] = {
      stage,
      reused: false,
      checkedAtMs: clock.nowMs(),
      evidence,
    };
  }

  const updated: typeof state.profiles = {
    ...state.profiles,
    [selected.effective.name]: {
      ...stored,
      liveChecks: {
        expansion: {
          fingerprint: selected.fingerprint,
          checkedAtMs: stages.expansion!.checkedAtMs,
          evidence: stages.expansion!.evidence!,
        },
        reranking: {
          fingerprint: selected.fingerprint,
          checkedAtMs: stages.reranking!.checkedAtMs,
          evidence: stages.reranking!.evidence!,
        },
      },
    },
  };
  savePreflightState({ schemaVersion: 1, profiles: updated }, statePath);

  return {
    profile: selected.effective.name,
    fingerprint: selected.fingerprint,
    declaration: selected.declaration,
    stages,
    approvalCurrent:
      stored.approval?.fingerprint === selected.fingerprint,
  };
}

/**
 * Records an explicit interactive approval bound to the current profile
 * fingerprint. Any later change to provider, endpoint, model, credential
 * reference, declared capability, reviewed pricing, or the privacy
 * declaration changes the fingerprint and voids this approval.
 */
export function recordProfileApproval(
  requestedProfile: string | null | undefined,
  fingerprint: string,
  deps: PreflightDeps = {},
): void {
  const env = deps.env ?? process.env;
  const effective = resolveSelectedProfile(requestedProfile, { env });
  if (effective === null) {
    throw invalidProfileError("No route profile is configured.");
  }
  const clock = deps.clock ?? systemClock;
  const statePath = deps.statePath !== undefined
    ? { filePath: deps.statePath }
    : {};
  const state = loadPreflightState(statePath);
  const stored = state.profiles[effective.name] ?? {};
  const updated: typeof state.profiles = {
    ...state.profiles,
    [effective.name]: {
      ...stored,
      approval: { fingerprint, approvedAtMs: clock.nowMs() },
    },
  };
  savePreflightState({ schemaVersion: 1, profiles: updated }, statePath);
}

/**
 * The full admission context the command layer needs to wire optional
 * persistence surfaces (caches, diagnostics) to the admitted profile.
 */
export interface AdmittedRouteContext {
  effective: EffectiveProfile;
  declaration: PrivacyDeclaration;
  /** Current profile fingerprint; participates in every cache identity. */
  fingerprint: string;
  /** Stored non-secret policy section of the selected profile. */
  policy: Record<string, unknown>;
}

/**
 * Search-time admission gate for remote routes, returning the full context
 * (effective profile, privacy declaration, fingerprint, policy). See
 * {@link admitRemoteRoutes} for the gate rules.
 */
export function admitRemoteRoutesWithContext(
  requestedProfile: string | null | undefined,
  options: { strict?: boolean } & PreflightDeps = {},
): AdmittedRouteContext | null {
  const strict = options.strict ?? false;
  const selected = selectProfileForPreflight(requestedProfile, options);
  if (selected === null) return null;

  const clock = options.clock ?? systemClock;
  const statePath = options.statePath !== undefined
    ? { filePath: options.statePath }
    : {};
  const state = loadPreflightState(statePath);
  const stored = state.profiles[selected.effective.name];

  if (
    stored?.approval === undefined ||
    stored.approval.fingerprint !== selected.fingerprint
  ) {
    throw privacyApprovalRequiredError(
      `Profile "${selected.effective.name}" requires current explicit privacy approval for its present configuration. ` +
        "Run `qmdx setup` interactively to review the privacy declaration and approve it.",
    );
  }

  const ttlMs = strict ? STRICT_LIVE_CHECK_TTL_MS : NORMAL_LIVE_CHECK_TTL_MS;
  const windowLabel = strict
    ? "24 hours (strict required-remote validation)"
    : "7 days";
  for (const stage of STAGES) {
    const record = stored.liveChecks?.[stage];
    if (
      record === undefined ||
      record.fingerprint !== selected.fingerprint ||
      !isFresh(record.checkedAtMs, ttlMs, clock)
    ) {
      throw preflightRequiredError(
        `Profile "${selected.effective.name}" has no current live capability check for the ${stage} route ` +
          `(valid for ${windowLabel}). Run \`qmdx setup\` to refresh it.`,
      );
    }
  }
  return {
    effective: selected.effective,
    declaration: selected.declaration,
    fingerprint: selected.fingerprint,
    policy: selected.policy,
  };
}

/**
 * Search-time admission gate for remote routes. Resolves the selected
 * profile and fails closed unless:

 * 1. an explicit approval is recorded for the exact current profile
 *    fingerprint; and
 * 2. every stage holds a live capability check with that same fingerprint,
 *    within the validity window (seven days normally, 24 hours for strict
 *    required-remote validation / acceptance runs).
 *
 * Returns null when no profile is selected (local-only mode). When it
 * returns, nothing has been transmitted anywhere; any deficiency throws a
 * configuration error so the caller emits the failure envelope without a
 * search payload.
 */
export function admitRemoteRoutes(
  requestedProfile: string | null | undefined,
  options: { strict?: boolean } & PreflightDeps = {},
): EffectiveProfile | null {
  return admitRemoteRoutesWithContext(requestedProfile, options)?.effective ??
    null;
}
