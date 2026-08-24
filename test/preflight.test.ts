import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualClock } from "../src/core/clock.js";
import { QmdxError } from "../src/core/errors.js";
import { reviewedProviderPricing } from "../src/core/pricing.js";
import {
  computeProfilePreflightFingerprint,
} from "../src/preflight/fingerprint.js";
import {
  fingerprintPrivacyDeclaration,
  parsePrivacyDeclaration,
  type PrivacyDeclaration,
} from "../src/preflight/privacy.js";
import {
  checkCohereCapabilities,
  checkOpenAiCompatibleCapabilities,
  type FetchLike,
  type StageCapabilityEvidence,
} from "../src/preflight/capability.js";
import { loadPreflightState, savePreflightState } from "../src/preflight/state.js";
import {
  NORMAL_LIVE_CHECK_TTL_MS,
  STRICT_LIVE_CHECK_TTL_MS,
  admitRemoteRoutes,
  profileFingerprint,
  recordProfileApproval,
  refreshProfilePreflight,
  type PreflightDeps,
} from "../src/preflight/preflight.js";

const DECLARATION: PrivacyDeclaration = {
  declarationVersion: 1,
  endpoint: "https://api.openai.com/v1",
  region: "eu",
  stagePayloads: {
    expansion: "The original query text only.",
    reranking: "Selected chunks plus a request-local correlation id.",
  },
  retention: "Zero retention.",
  trainingUse: "Excluded from training.",
  reviewedSources: ["https://example.com/policy"],
};

const EXPANSION_ROUTE = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  credentialEnv: "QMDX_TEST_EXPANSION_KEY",
};

const RERANKING_ROUTE = {
  provider: "cohere",
  endpoint: "https://api.cohere.com",
  model: "rerank-v4.0-pro",
  credentialEnv: "QMDX_TEST_RERANKING_KEY",
};

function fingerprintOf(
  overrides: Partial<Parameters<typeof computeProfilePreflightFingerprint>[0]> = {},
): string {
  return computeProfilePreflightFingerprint({
    expansion: EXPANSION_ROUTE,
    reranking: RERANKING_ROUTE,
    expansionPricing: reviewedProviderPricing.rateFor("openai", "gpt-4o-mini"),
    rerankingPricing: reviewedProviderPricing.rateFor("cohere", "rerank-v4.0-pro"),
    privacyDeclarationFingerprint: fingerprintPrivacyDeclaration(DECLARATION),
    ...overrides,
  });
}

interface StubResponse {
  status?: number;
  body?: unknown;
}

function stubFetch(
  responsesByPrefix: Record<string, StubResponse>,
  log: Array<{ url: string; auth: string | undefined }>,
): FetchLike {
  return async (url, init) => {
    log.push({ url, auth: init?.headers?.Authorization });
    const match = Object.entries(responsesByPrefix).find(([prefix]) =>
      url.startsWith(prefix),
    );
    const response = match?.[1] ?? {};
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      json: async () => response.body,
    };
  };
}

let stateDir: string;
let emptyDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qmdx-preflight-unit-"));
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({
      version: 1,
      defaultProfile: "default",
      profiles: {
        default: {
          expansion: EXPANSION_ROUTE,
          reranking: RERANKING_ROUTE,
          privacy: { declaration: DECLARATION },
        },
      },
    }),
    "utf8",
  );
  emptyDir = mkdtempSync(join(tmpdir(), "qmdx-preflight-empty-"));
});

afterEach(() => {
  void stateDir;
  void emptyDir;
});

const ENV = {
  QMDX_TEST_EXPANSION_KEY: "unit-expansion-credential",
  QMDX_TEST_RERANKING_KEY: "unit-reranking-credential",
};

function deps(overrides: PreflightDeps = {}): PreflightDeps & { statePath: string } {
  return {
    env: { ...ENV, QMDX_CONFIG_DIR: stateDir },
    clock: manualClock(1_000_000),
    fetchImpl: stubFetch({}, []),
    statePath: join(stateDir, "state.json"),
    ...overrides,
  };
}

describe("privacy declaration parsing", () => {
  it("accepts a complete versioned declaration", () => {
    const parsed = parsePrivacyDeclaration(
      { declaration: DECLARATION },
      'profile "p"',
    );
    expect(parsed).toEqual(DECLARATION);
  });

  it("rejects a missing declaration as invalid_profile", () => {
    for (const section of [undefined, {}, { other: true }]) {
      let error!: QmdxError;
      try {
        parsePrivacyDeclaration(section, 'profile "p"');
      } catch (caught) {
        error = caught as QmdxError;
      }
      expect(error.code).toBe("invalid_profile");
      expect(error.category).toBe("configuration");
    }
  });

  it("rejects incomplete declarations, naming the missing field", () => {
    const incomplete: Record<string, unknown> = { ...DECLARATION };
    delete incomplete.retention;
    expect(() =>
      parsePrivacyDeclaration({ declaration: incomplete }, 'profile "p"'),
    ).toThrow(/retention/);

    const badVersion = { ...DECLARATION, declarationVersion: 0 };
    expect(() =>
      parsePrivacyDeclaration({ declaration: badVersion }, 'profile "p"'),
    ).toThrow(/declarationVersion/);

    const noSources = { ...DECLARATION, reviewedSources: [] };
    expect(() =>
      parsePrivacyDeclaration({ declaration: noSources }, 'profile "p"'),
    ).toThrow(/reviewedSources/);
  });

  it("fingerprints differ when any declaration content changes", () => {
    const base = fingerprintPrivacyDeclaration(DECLARATION);
    const changed = fingerprintPrivacyDeclaration({
      ...DECLARATION,
      declarationVersion: 2,
    });
    expect(changed).not.toBe(base);
  });
});

describe("profile preflight fingerprint invalidation", () => {
  it("is stable for identical inputs", () => {
    expect(fingerprintOf()).toBe(fingerprintOf());
  });

  it("changes when a route field changes", () => {
    const base = fingerprintOf();
    expect(
      fingerprintOf({
        expansion: { ...EXPANSION_ROUTE, endpoint: "https://proxy.example.com/v1" },
      }),
    ).not.toBe(base);
    expect(
      fingerprintOf({
        reranking: { ...RERANKING_ROUTE, model: "rerank-v3.5-medium" },
      }),
    ).not.toBe(base);
    expect(
      fingerprintOf({
        expansion: { ...EXPANSION_ROUTE, credentialEnv: "OTHER_KEY" },
      }),
    ).not.toBe(base);
    expect(
      fingerprintOf({
        expansion: { ...EXPANSION_ROUTE, provider: "openrouter" },
      }),
    ).not.toBe(base);
  });

  it("changes when reviewed pricing or privacy changes", () => {
    const base = fingerprintOf();
    const pricing = reviewedProviderPricing.rateFor("openai", "gpt-4o-mini")!;
    expect(
      fingerprintOf({
        expansionPricing: { ...pricing, usdPerMillionInputTokens: 0.99 },
      }),
    ).not.toBe(base);
    expect(
      fingerprintOf({
        privacyDeclarationFingerprint: "different",
      }),
    ).not.toBe(base);
  });
});

describe("capability-check seams", () => {
  const expansionRoute = {
    stage: "expansion" as const,
    ...EXPANSION_ROUTE,
  };

  it("authenticates against the OpenAI-compatible catalog and verifies the model", async () => {
    const log: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = stubFetch(
      {
        "https://api.openai.com/v1/models": {
          body: { data: [{ id: "gpt-4o-mini" }, { id: "other-model" }] },
        },
      },
      log,
    );
    const evidence = await checkOpenAiCompatibleCapabilities(
      expansionRoute,
      "secret-value",
      fetchImpl,
    );
    expect(evidence.modelListed).toBe(true);
    expect(evidence.strictSchemaRequired).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(log[0]!.auth).toBe("Bearer secret-value");
  });

  it("fails unsupported capability when the model is absent from the catalog", async () => {
    const fetchImpl = stubFetch(
      { "https://api.openai.com/v1/models": { body: { data: [{ id: "other" }] } } },
      [],
    );
    await expect(
      checkOpenAiCompatibleCapabilities(expansionRoute, "c", fetchImpl),
    ).rejects.toMatchObject({ code: "invalid_profile" });
  });

  it("maps HTTP 401/403 to failed authentication without echoing the credential", async () => {
    const fetchImpl = stubFetch(
      { "https://api.openai.com/v1/models": { status: 401 } },
      [],
    );
    let error!: QmdxError;
    try {
      await checkOpenAiCompatibleCapabilities(expansionRoute, "secret-value", fetchImpl);
    } catch (caught) {
      error = caught as QmdxError;
    }
    expect(error.code).toBe("preflight_required");
    expect(error.message).toContain("authentication");
    expect(error.message).not.toContain("secret-value");
  });

  it("requires the Cohere rerank endpoint when the catalog declares endpoints", async () => {
    const rerankingRoute = { stage: "reranking" as const, ...RERANKING_ROUTE };
    const capable = stubFetch(
      {
        "https://api.cohere.com/v1/models": {
          body: { models: [{ name: "rerank-v4.0-pro", endpoints: ["rerank"] }] },
        },
      },
      [],
    );
    const evidence: StageCapabilityEvidence = await checkCohereCapabilities(
      rerankingRoute,
      "c",
      capable,
    );
    expect(evidence.modelListed).toBe(true);
    expect(evidence.declaredEndpoints).toEqual(["rerank"]);

    const incapable = stubFetch(
      {
        "https://api.cohere.com/v1/models": {
          body: { models: [{ name: "rerank-v4.0-pro", endpoints: ["embed"] }] },
        },
      },
      [],
    );
    await expect(
      checkCohereCapabilities(rerankingRoute, "c", incapable),
    ).rejects.toMatchObject({ code: "invalid_profile" });
  });
});

describe("refreshProfilePreflight", () => {
  it("records fresh checks and reuses them on the next call without network", async () => {
    const log: Array<{ url: string; auth: string | undefined }> = [];
    const d = deps({
      fetchImpl: stubFetch(
        {
          "https://api.openai.com/v1/models": {
            body: { data: [{ id: "gpt-4o-mini" }] },
          },
          "https://api.cohere.com/v1/models": {
            body: { models: [{ name: "rerank-v4.0-pro", endpoints: ["rerank"] }] },
          },
        },
        log,
      ),
    });
    const first = await refreshProfilePreflight(null, d);
    expect(first.stages.expansion!.reused).toBe(false);
    expect(first.approvalCurrent).toBe(false);
    expect(log).toHaveLength(2);

    const second = await refreshProfilePreflight(null, d);
    expect(second.stages.expansion!.reused).toBe(true);
    expect(second.stages.reranking!.reused).toBe(true);
    expect(log).toHaveLength(2);
  });

  it("rechecks after the normal validity window lapses", async () => {
    const log: Array<{ url: string; auth: string | undefined }> = [];
    const clock = manualClock(0);
    const d = deps({
      clock,
      fetchImpl: stubFetch(
        {
          "https://api.openai.com/v1/models": {
            body: { data: [{ id: "gpt-4o-mini" }] },
          },
          "https://api.cohere.com/v1/models": {
            body: { models: [{ name: "rerank-v4.0-pro" }] },
          },
        },
        log,
      ),
    });
    await refreshProfilePreflight(null, d);
    clock.advance(NORMAL_LIVE_CHECK_TTL_MS - 1);
    const stillFresh = await refreshProfilePreflight(null, d);
    expect(stillFresh.stages.expansion!.reused).toBe(true);
    clock.advance(1);
    const expired = await refreshProfilePreflight(null, d);
    expect(expired.stages.expansion!.reused).toBe(false);
    expect(log).toHaveLength(4);
  });

  it("propagates capability failures as configuration errors", async () => {
    const d = deps({
      fetchImpl: stubFetch(
        {
          "https://api.openai.com/v1/models": { body: { data: [] } },
          "https://api.cohere.com/v1/models": { body: { models: [] } },
        },
        [],
      ),
    });
    await expect(refreshProfilePreflight(null, d)).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });
});

describe("admitRemoteRoutes fails closed", () => {
  function seedCurrentState(clockAtMs: number): void {
    const fingerprint = profileFingerprint(
      {
        name: "default",
        expansion: { stage: "expansion", ...EXPANSION_ROUTE },
        reranking: { stage: "reranking", ...RERANKING_ROUTE },
      },
      DECLARATION,
    );
    const evidence = (stage: "expansion" | "reranking"): StageCapabilityEvidence => ({
      stage,
      providerKind: stage === "expansion" ? "openai-compatible" : "cohere",
      modelsUrl: "https://stub/models",
      modelListed: true,
      strictSchemaRequired: null,
      declaredEndpoints: null,
    });
    savePreflightState(
      {
        schemaVersion: 1,
        profiles: {
          default: {
            approval: { fingerprint, approvedAtMs: clockAtMs },
            liveChecks: {
              expansion: { fingerprint, checkedAtMs: clockAtMs, evidence: evidence("expansion") },
              reranking: { fingerprint, checkedAtMs: clockAtMs, evidence: evidence("reranking") },
            },
          },
        },
      },
      { filePath: join(stateDir, "state.json") },
    );
  }

  it("returns null when no profile is selected", () => {
    expect(
      admitRemoteRoutes(null, {
        env: { QMDX_CONFIG_DIR: emptyDir },
        clock: manualClock(0),
        statePath: join(stateDir, "state.json"),
      }),
    ).toBeNull();
  });

  function expectCode(action: () => unknown, code: string): void {
    let error!: QmdxError;
    try {
      action();
    } catch (caught) {
      error = caught as QmdxError;
    }
    expect(error.code).toBe(code);
    expect(error.category).toBe("configuration");
  }

  it("requires explicit approval before first use", () => {
    expectCode(
      () =>
        admitRemoteRoutes(null, {
          env: { ...ENV, QMDX_CONFIG_DIR: stateDir },
          clock: manualClock(Date.now()),
          statePath: join(stateDir, "state.json"),
        }),
      "privacy_approval_required",
    );
  });

  it("accepts current approval and live checks within both windows", () => {
    const now = Date.now();
    seedCurrentState(now);
    const base = { env: { ...ENV, QMDX_CONFIG_DIR: stateDir }, statePath: join(stateDir, "state.json") };
    expect(admitRemoteRoutes(null, base)).not.toBeNull();
    expect(admitRemoteRoutes(null, { ...base, strict: true })).not.toBeNull();

    const clock = manualClock(now + STRICT_LIVE_CHECK_TTL_MS - 1);
    expect(admitRemoteRoutes(null, { ...base, strict: true, clock })).not.toBeNull();
    expect(admitRemoteRoutes(null, { ...base, clock })).not.toBeNull();

    // Strict window expires after 24h while normal use stays valid.
    const pastStrict = manualClock(now + STRICT_LIVE_CHECK_TTL_MS);
    expectCode(
      () => admitRemoteRoutes(null, { ...base, strict: true, clock: pastStrict }),
      "preflight_required",
    );

    const nearNormal = manualClock(now + NORMAL_LIVE_CHECK_TTL_MS - 1);
    expect(admitRemoteRoutes(null, { ...base, clock: nearNormal })).not.toBeNull();

    const pastNormal = manualClock(now + NORMAL_LIVE_CHECK_TTL_MS);
    expectCode(
      () => admitRemoteRoutes(null, { ...base, clock: pastNormal }),
      "preflight_required",
    );
  });

  it("voids approval and live checks when the profile changes", () => {
    const now = Date.now();
    seedCurrentState(now);
    // Changing the credential reference must invalidate everything.
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        defaultProfile: "default",
        profiles: {
          default: {
            expansion: {
              ...EXPANSION_ROUTE,
              credentialEnv: "QMDX_TEST_EXPANSION_KEY_ALT",
            },
            reranking: RERANKING_ROUTE,
            privacy: { declaration: DECLARATION },
          },
        },
      }),
      "utf8",
    );
    expectCode(
      () =>
        admitRemoteRoutes(null, {
          env: {
            ...ENV,
            QMDX_TEST_EXPANSION_KEY_ALT: ENV.QMDX_TEST_EXPANSION_KEY,
            QMDX_CONFIG_DIR: stateDir,
          },
          clock: manualClock(now),
          statePath: join(stateDir, "state.json"),
        }),
      "privacy_approval_required",
    );
  });

  it("treats a corrupt or missing state file as absent evidence", () => {
    const corruptPath = join(stateDir, "corrupt.json");
    writeFileSync(corruptPath, "{not json", "utf8");
    expectCode(
      () =>
        admitRemoteRoutes(null, {
          env: { ...ENV, QMDX_CONFIG_DIR: stateDir },
          clock: manualClock(Date.now()),
          statePath: corruptPath,
        }),
      "privacy_approval_required",
    );
  });

  it("records approval bound to the exact current fingerprint only", async () => {
    const clock = manualClock(1_000_000);
    const d = deps({
      clock,
      fetchImpl: stubFetch(
        {
          "https://api.openai.com/v1/models": {
            body: { data: [{ id: "gpt-4o-mini" }] },
          },
          "https://api.cohere.com/v1/models": {
            body: { models: [{ name: "rerank-v4.0-pro", endpoints: ["rerank"] }] },
          },
        },
        [],
      ),
    });
    const report = await refreshProfilePreflight(null, d);
    recordProfileApproval(null, report.fingerprint, d);
    const stored = loadPreflightState({ filePath: d.statePath as string });
    expect(stored.profiles.default?.approval?.fingerprint).toBe(report.fingerprint);
    expect(stored.profiles.default?.approval?.approvedAtMs).toBe(1_000_000);
  });
});
