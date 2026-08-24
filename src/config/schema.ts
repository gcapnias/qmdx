import { invalidProfileConfigError } from "../core/errors.js";

export const CONFIG_VERSION = 1;

/**
 * One remote-inference route (expansion or reranking) as stored in a profile.
 * `credentialEnv` is the NAME of an environment variable; literal credentials
 * are never valid profile content.
 */
export interface RouteSettings {
  provider?: string;
  endpoint?: string;
  model?: string;
  credentialEnv?: string;
}

export interface RouteProfile {
  expansion?: RouteSettings;
  reranking?: RouteSettings;
  policy?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
}

export interface QmdxConfig {
  version: typeof CONFIG_VERSION;
  defaultProfile?: string;
  profiles?: Record<string, RouteProfile>;
}

const PROFILE_KEYS: ReadonlySet<string> = new Set([
  "expansion",
  "reranking",
  "policy",
  "privacy",
]);

const ROUTE_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "endpoint",
  "model",
  "credentialEnv",
]);

const CREDENTIAL_FIELD_NAME =
  /pass(word)?|secret|token|api[-_]?key|credential|auth|private[-_]?key/i;

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/** Validates an already-parsed top-level configuration document in place. */
export function validateConfig(value: unknown): asserts value is QmdxConfig {
  if (!isPlainObject(value)) {
    throw invalidProfileConfigError(
      "Configuration must be a JSON object.",
    );
  }
  if (value.version !== CONFIG_VERSION) {
    throw invalidProfileConfigError(
      `Unsupported configuration version ${JSON.stringify(value.version)}; this build reads version ${CONFIG_VERSION} only.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "version" && key !== "defaultProfile" && key !== "profiles") {
      throw unknownFieldError(key, "configuration");
    }
  }
  const { defaultProfile } = value;
  if (defaultProfile !== undefined) {
    if (typeof defaultProfile !== "string" || defaultProfile.trim() === "") {
      throw invalidProfileConfigError(
        '"defaultProfile" must be a non-empty profile name.',
      );
    }
    const defined = value.profiles;
    if (!isPlainObject(defined) || !(defaultProfile in defined)) {
      throw invalidProfileConfigError(
        `"defaultProfile" references profile "${defaultProfile}", which is not defined.`,
      );
    }
  }
  const profiles = value.profiles ?? {};
  if (!isPlainObject(profiles)) {
    throw invalidProfileConfigError('"profiles" must be an object.');
  }
  for (const [name, profile] of Object.entries(profiles)) {
    validateProfile(profile, `profile "${name}"`);
  }
}

export function validateProfile(
  value: unknown,
  context: string,
): asserts value is RouteProfile {
  if (!isPlainObject(value)) {
    throw invalidProfileConfigError(`${context} must be a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!PROFILE_KEYS.has(key)) {
      throw unknownFieldError(key, context);
    }
    const section = value[key];
    if (key === "policy" || key === "privacy") {
      if (!isPlainObject(section)) {
        throw invalidProfileConfigError(
          `${context} field "${key}" must be a JSON object.`,
        );
      }
      continue;
    }
    validateRouteSettings(section, `${context} route "${key}"`);
  }
}

function validateRouteSettings(
  value: unknown,
  context: string,
): asserts value is RouteSettings {
  if (!isPlainObject(value)) {
    throw invalidProfileConfigError(`${context} must be a JSON object.`);
  }
  const fields = value;
  for (const [key, fieldValue] of Object.entries(fields)) {
    if (!ROUTE_KEYS.has(key)) {
      if (CREDENTIAL_FIELD_NAME.test(key)) {
        throw invalidProfileConfigError(
          `${context} field "${key}" looks like a literal credential; only "credentialEnv" naming an environment variable is permitted.`,
        );
      }
      throw unknownFieldError(key, context);
    }
    if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
      throw invalidProfileConfigError(
        `${context} field "${key}" must be a non-empty string.`,
      );
    }
  }
  if (fields.endpoint !== undefined) {
    validateEndpoint(fields.endpoint as string, context);
  }
  const credentialEnv = fields.credentialEnv as string | undefined;
  if (credentialEnv !== undefined && !ENV_VAR_NAME.test(credentialEnv)) {
    throw invalidProfileConfigError(
      `${context} field "credentialEnv" must name an environment variable (matched /^[A-Za-z_][A-Za-z0-9_]*$/), not hold a credential.`,
    );
  }
}

function validateEndpoint(endpoint: string, context: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalidProfileConfigError(
      `${context} field "endpoint" must be an absolute http(s) URL.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidProfileConfigError(
      `${context} field "endpoint" must use http(s).`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidProfileConfigError(
      `${context} field "endpoint" embeds credentials in its URL; put credentials in the environment variable named by "credentialEnv".`,
    );
  }
}

function unknownFieldError(key: string, context: string): Error {
  return invalidProfileConfigError(
    CREDENTIAL_FIELD_NAME.test(key)
      ? `${context} field "${key}" looks like a literal credential; QMDX configuration never stores credentials.`
      : `${context} has unknown field "${key}".`,
  );
}
