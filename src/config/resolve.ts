import {
  invalidProfileError,
  missingCredentialsError,
} from "../core/errors.js";
import type { RouteProfile, RouteSettings } from "./schema.js";
import { loadUserConfig, type ConfigStoreOptions } from "./store.js";

export type RemoteStage = "expansion" | "reranking";

/**
 * Built-in default routes (spec lines 53-65). They are the last link in the
 * resolution chain: command-line option > environment variable > selected
 * profile > built-in default.
 */
export const BUILT_IN_ROUTES: Record<RemoteStage, Required<RouteSettings>> = {
  expansion: {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    credentialEnv: "OPENAI_API_KEY",
  },
  reranking: {
    provider: "cohere",
    endpoint: "https://api.cohere.com",
    model: "rerank-v4.0-pro",
    credentialEnv: "COHERE_API_KEY",
  },
};

const STAGE_ENV_PREFIX: Record<RemoteStage, string> = {
  expansion: "QMDX_EXPANSION_",
  reranking: "QMDX_RERANKING_",
};

/** Non-secret route fields that may be overridden per environment variable. */
const ENV_OVERRIDABLE_FIELDS = [
  "PROVIDER",
  "ENDPOINT",
  "MODEL",
  "CREDENTIAL_ENV",
] as const;

export interface EffectiveRoute {
  stage: RemoteStage;
  provider: string;
  endpoint: string;
  model: string;
  /** Environment-variable NAME holding the credential; never a credential. */
  credentialEnv: string;
}

export interface EffectiveProfile {
  name: string;
  expansion: EffectiveRoute;
  reranking: EffectiveRoute;
}

export interface RouteCliOverrides {
  provider?: string;
  endpoint?: string;
  model?: string;
  credentialEnv?: string;
}

export interface ResolveProfileOptions extends ConfigStoreOptions {
  /** Highest-precedence command-line overrides (no credentials accepted). */
  cli?: { expansion?: RouteCliOverrides; reranking?: RouteCliOverrides };
}

/**
 * Resolves the selected profile to fully-merged, non-secret effective routes.
 *
 * - `requestedProfile === null` uses `defaultProfile` when configured.
 * - Returns null when neither is set (QMDX then runs without remote routes).
 * - Throws configuration/invalid_profile when the requested or default
 *   profile does not exist or the stored configuration is invalid.
 * - Throws configuration/missing_credentials when the selected profile's
 *   declared credential environment variable is unset at invocation time.
 *
 * The returned structure contains only non-secret settings; resolve the
 * credential separately via {@link resolveCredential}.
 */
export function resolveSelectedProfile(
  requestedProfile: string | null | undefined,
  options: ResolveProfileOptions = {},
): EffectiveProfile | null {
  const config = loadUserConfig(options);
  const name = requestedProfile ?? config?.defaultProfile ?? null;
  if (name === null) return null;
  const profiles = config?.profiles ?? {};
  if (!(name in profiles)) throw invalidProfileError(name);

  const profile = profiles[name]!;
  const effective: EffectiveProfile = {
    name,
    expansion: resolveRoute("expansion", profile, options),
    reranking: resolveRoute("reranking", profile, options),
  };
  const env = options.env ?? process.env;
  resolveCredential(effective.expansion, env);
  resolveCredential(effective.reranking, env);
  return effective;
}

function resolveRoute(
  stage: RemoteStage,
  profile: RouteProfile,
  options: ResolveProfileOptions,
): EffectiveRoute {
  const env = options.env ?? process.env;
  const profileRoute: RouteSettings = profile[stage] ?? {};
  const merged = { ...BUILT_IN_ROUTES[stage], ...profileRoute };

  const prefix = STAGE_ENV_PREFIX[stage];
  for (const field of ENV_OVERRIDABLE_FIELDS) {
    const value = env[`${prefix}${field}`];
    if (value !== undefined && value.trim() !== "") {
      const key = field === "CREDENTIAL_ENV"
        ? "credentialEnv"
        : field.toLowerCase();
      merged[key as keyof RouteSettings] = value;
    }
  }

  const cliOverrides =
    stage === "expansion" ? options.cli?.expansion : options.cli?.reranking;
  Object.assign(merged, cliOverrides ?? {});

  return {
    stage,
    provider: merged.provider,
    endpoint: merged.endpoint,
    model: merged.model,
    credentialEnv: merged.credentialEnv,
  };
}

/**
 * Resolves the credential for an effective route from the single environment
 * variable its `credentialEnv` names. Throws configuration/missing_credentials
 * when it is unset. The value must never be logged, stored, or echoed.
 */
export function resolveCredential(
  route: EffectiveRoute,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[route.credentialEnv];
  if (value === undefined || value === "") {
    throw missingCredentialsError(route.credentialEnv, route.stage);
  }
  return value;
}

/**
 * Diagnostic projection of an effective profile: non-secret identity fields
 * only. Safe for envelope warnings and metadata by construction.
 */
export function routeDiagnostic(route: EffectiveRoute): {
  stage: RemoteStage;
  provider: string;
  endpoint: string;
  model: string;
  credentialEnv: string;
} {
  return {
    stage: route.stage,
    provider: route.provider,
    endpoint: route.endpoint,
    model: route.model,
    credentialEnv: route.credentialEnv,
  };
}
