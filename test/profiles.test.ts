import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateConfig,
  type QmdxConfig,
} from "../src/config/schema.js";
import { userConfigDir, userConfigFilePath } from "../src/config/location.js";
import { loadUserConfig, saveUserConfig } from "../src/config/store.js";
import {
  BUILT_IN_ROUTES,
  resolveCredential,
  resolveSelectedProfile,
  routeDiagnostic,
} from "../src/config/resolve.js";
import { QmdxError } from "../src/core/errors.js";

const SPEC_EXAMPLE: QmdxConfig = {
  version: 1,
  defaultProfile: "default",
  profiles: {
    default: {
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
      policy: {},
      privacy: {},
    },
  },
};

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "qmdx-profile-test-"));
}

function expectConfigError(fn: () => unknown): QmdxError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(QmdxError);
    const qmdxError = error as QmdxError;
    expect(qmdxError.category).toBe("configuration");
    return qmdxError;
  }
  throw new Error("expected function to throw a configuration error");
}

describe("schema validation", () => {
  it("accepts the spec example shape", () => {
    expect(() => validateConfig(structuredClone(SPEC_EXAMPLE))).not.toThrow();
  });

  it("rejects other schema versions", () => {
    const error = expectConfigError(() =>
      validateConfig({ version: 2, profiles: {} }),
    );
    expect(error.code).toBe("invalid_profile");
    expect(error.message).toContain("version 2");
  });

  it("rejects unknown top-level and profile fields", () => {
    expectConfigError(() =>
      validateConfig({ version: 1, extra: true }),
    );
    expectConfigError(() =>
      validateConfig({
        version: 1,
        profiles: { p: { expansion: { model: "m", retries: 3 } } },
      }),
    );
  });

  it("rejects literal-credential-shaped profile fields without echoing values", () => {
    const secret = "sk-literal-secret-do-not-leak";
    const error = expectConfigError(() =>
      validateConfig({
        version: 1,
        profiles: { p: { expansion: { apiKey: secret } as never } },
      }),
    );
    expect(error.message).toContain("literal credential");
    expect(error.message).not.toContain(secret);
  });

  it("rejects credentialEnv values that are not environment-variable names", () => {
    for (const bad of ["sk-abc123", "has space", "1STARTS_WITH_DIGIT", ""]) {
      expectConfigError(() =>
        validateConfig({
          version: 1,
          profiles: { p: { expansion: { credentialEnv: bad } } },
        }),
      );
    }
  });

  it("rejects endpoints with embedded credentials or non-http schemes", () => {
    expectConfigError(() =>
      validateConfig({
        version: 1,
        profiles: {
          p: { reranking: { endpoint: "https://user:pass@api.example.com" } },
        },
      }),
    );
    expectConfigError(() =>
      validateConfig({
        version: 1,
        profiles: { p: { reranking: { endpoint: "ftp://api.example.com" } } },
      }),
    );
  });

  it("rejects a defaultProfile that names no defined profile", () => {
    expectConfigError(() =>
      validateConfig({ version: 1, defaultProfile: "missing", profiles: {} }),
    );
  });
});

describe("config store", () => {
  it("round-trips a version-1 config through the OS-standard path", () => {
    const dir = tempConfigDir();
    const filePath = join(dir, "config.json");
    saveUserConfig(structuredClone(SPEC_EXAMPLE), { filePath });
    expect(loadUserConfig({ filePath })).toEqual(SPEC_EXAMPLE);
    const onDisk = readFileSync(filePath, "utf8");
    expect(JSON.parse(onDisk)).toEqual(SPEC_EXAMPLE);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports absent configs as null and malformed ones as invalid_profile", () => {
    const dir = tempConfigDir();
    expect(loadUserConfig({ filePath: join(dir, "config.json") })).toBeNull();

    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "{not json", "utf8");
    const error = expectConfigError(() => loadUserConfig({ filePath }));
    expect(error.code).toBe("invalid_profile");

    writeFileSync(filePath, JSON.stringify({ version: 9 }), "utf8");
    expectConfigError(() => loadUserConfig({ filePath }));
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the platform-standard file path per env override chain", () => {
    expect(userConfigFilePath({ QMDX_CONFIG_DIR: "/tmp/cfg" })).toBe(
      join("/tmp/cfg", "config.json"),
    );
    const resolved = userConfigDir({
      XDG_CONFIG_HOME: "/xdg",
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    });
    const expectedBase =
      process.platform === "win32"
        ? "C:\\Users\\u\\AppData\\Roaming"
        : "/xdg";
    expect(resolved).toBe(join(expectedBase, "qmdx"));
  });
});

describe("profile selection and resolution precedence", () => {
  const env = {
    QMDX_CONFIG_DIR: "unused",
    OPENAI_API_KEY: "k-expansion",
    COHERE_API_KEY: "k-rerank",
  };

  it("returns null when no profile is requested and none is default", () => {
    expect(resolveSelectedProfile(null, { env })).toBeNull();
  });

  it("uses the configured default profile when no option is supplied", () => {
    const dir = tempConfigDir();
    saveUserConfig(structuredClone(SPEC_EXAMPLE), { filePath: join(dir, "config.json") });
    const effective = resolveSelectedProfile(null, { env, filePath: join(dir, "config.json") });
    expect(effective?.name).toBe("default");
    expect(effective?.expansion).toMatchObject({
      stage: "expansion",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      credentialEnv: "OPENAI_API_KEY",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers an explicitly requested profile over the default", () => {
    const dir = tempConfigDir();
    const config = structuredClone(SPEC_EXAMPLE);
    config.profiles!.strict = {
      expansion: { provider: "other", model: "big-model" },
      reranking: {},
    };
    saveUserConfig(config, { filePath: join(dir, "config.json") });
    const opts = { env, filePath: join(dir, "config.json") };
    expect(resolveSelectedProfile(null, opts)?.name).toBe("default");
    const strict = resolveSelectedProfile("strict", opts)!;
    expect(strict.name).toBe("strict");
    expect(strict.expansion.provider).toBe("other");
    expect(strict.reranking.provider).toBe(BUILT_IN_ROUTES.reranking.provider);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills unspecified fields from built-in defaults", () => {
    const dir = tempConfigDir();
    saveUserConfig(
      {
        version: 1,
        defaultProfile: "partial",
        profiles: { partial: { expansion: { model: "custom-model" } } },
      },
      { filePath: join(dir, "config.json") },
    );
    const effective = resolveSelectedProfile(null, {
      env,
      filePath: join(dir, "config.json"),
    })!;
    expect(effective.expansion.model).toBe("custom-model");
    expect(effective.expansion.endpoint).toBe(BUILT_IN_ROUTES.expansion.endpoint);
    expect(effective.expansion.credentialEnv).toBe(BUILT_IN_ROUTES.expansion.credentialEnv);
    expect(effective.reranking).toEqual({
      stage: "reranking",
      ...BUILT_IN_ROUTES.reranking,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies command-line > environment > selected-profile > built-in order", () => {
    const dir = tempConfigDir();
    saveUserConfig(
      {
        version: 1,
        defaultProfile: "p",
        profiles: {
          p: {
            expansion: {
              provider: "profile-provider",
              endpoint: "https://profile.example.com",
              model: "profile-model",
            },
          },
        },
      },
      { filePath: join(dir, "config.json") },
    );
    const opts = {
      env: {
        ...env,
        QMDX_EXPANSION_ENDPOINT: "https://env.example.com",
        QMDX_EXPANSION_MODEL: "env-model",
      },
      cli: { expansion: { model: "cli-model" } },
      filePath: join(dir, "config.json"),
    };
    const route = resolveSelectedProfile(null, opts)!.expansion;
    expect(route.provider).toBe("profile-provider");
    expect(route.endpoint).toBe("https://env.example.com");
    expect(route.model).toBe("cli-model");
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws invalid_profile for missing selections and missing_credentials for unset vars", () => {
    const dir = tempConfigDir();
    saveUserConfig(structuredClone(SPEC_EXAMPLE), { filePath: join(dir, "config.json") });
    const opts = { env, filePath: join(dir, "config.json") };

    const missing = expectConfigError(() =>
      resolveSelectedProfile("enterprise", opts),
    );
    expect(missing.code).toBe("invalid_profile");

    const noCreds = expectConfigError(() =>
      resolveSelectedProfile(null, { env: {}, filePath: join(dir, "config.json") }),
    );
    expect(noCreds.code).toBe("missing_credentials");
    expect(noCreds.message).not.toContain("k-expansion");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("credential handling", () => {
  it("resolveCredential reads only the named variable and never stores it", () => {
    const dir = tempConfigDir();
    saveUserConfig(structuredClone(SPEC_EXAMPLE), { filePath: join(dir, "config.json") });
    const effective = resolveSelectedProfile(null, {
      env: { OPENAI_API_KEY: "openai-secret", COHERE_API_KEY: "cohere-secret" },
      filePath: join(dir, "config.json"),
    })!;
    const serialized = JSON.stringify([effective, routeDiagnostic(effective.expansion)]);
    expect(serialized).not.toContain("cohere-secret");
    expect(resolveCredential(effective.reranking, { COHERE_API_KEY: "cohere-secret" })).toBe(
      "cohere-secret",
    );
    const missing = expectConfigError(() =>
      resolveCredential(effective.expansion, { COHERE_API_KEY: "cohere-secret" }),
    );
    expect(missing.code).toBe("missing_credentials");
    rmSync(dir, { recursive: true, force: true });
  });
});
