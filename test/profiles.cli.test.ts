import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmbeddedTestIndex,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import type { ErrorEnvelope, ResultEnvelope } from "../src/core/envelope.js";
import { reviewedProviderPricing } from "../src/core/pricing.js";
import { computeProfilePreflightFingerprint } from "../src/preflight/fingerprint.js";
import {
  fingerprintPrivacyDeclaration,
  type PrivacyDeclaration,
} from "../src/preflight/privacy.js";
import { savePreflightState } from "../src/preflight/state.js";

const SECRET = "sk-qmdx-test-literal-secret-9f2a";

const DECLARATION: PrivacyDeclaration = {
  declarationVersion: 1,
  endpoint: "https://api.openai.com/v1",
  region: "us",
  stagePayloads: {
    expansion: "The original query text only.",
    reranking: "Selected chunks plus a request-local correlation id.",
  },
  retention: "Zero retention; prompts and outputs are not stored.",
  trainingUse: "Provider terms exclude this workload from training.",
  reviewedSources: ["https://openai.com/policies", "https://cohere.com/legal"],
};

const CONFIG = {
  version: 1,
  defaultProfile: "default",
  profiles: {
    default: {
      expansion: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        credentialEnv: "QMDX_TEST_EXPANSION_KEY",
      },
      reranking: {
        provider: "cohere",
        endpoint: "https://api.cohere.com",
        model: "rerank-v4.0-pro",
        credentialEnv: "QMDX_TEST_RERANKING_KEY",
      },
      policy: {},
      privacy: { declaration: DECLARATION },
    },
  },
};

/**
 * Seeds the local preflight state (approval + current live checks) for the
 * fixture profile so these ticket-#7 CLI wiring tests keep exercising their
 * own concerns offline instead of contacting real provider catalogs.
 */
function seedDefaultProfilePreflight(configDirPath: string): void {
  const expansionEndpoint = expansionStubUrl;
  const fingerprint = computeProfilePreflightFingerprint({
    expansion: {
      provider: "openai",
      endpoint: expansionEndpoint,
      model: "gpt-4o-mini",
      credentialEnv: "QMDX_TEST_EXPANSION_KEY",
    },
    reranking: {
      provider: "cohere",
      endpoint: "https://api.cohere.com",
      model: "rerank-v4.0-pro",
      credentialEnv: "QMDX_TEST_RERANKING_KEY",
    },
    expansionPricing: reviewedProviderPricing.rateFor("openai", "gpt-4o-mini"),
    rerankingPricing: reviewedProviderPricing.rateFor("cohere", "rerank-v4.0-pro"),
    privacyDeclarationFingerprint: fingerprintPrivacyDeclaration(DECLARATION),
  });
  const now = Date.now();
  const evidence = (stage: "expansion" | "reranking", modelsUrl: string) => ({
    stage,
    providerKind: stage === "expansion" ? ("openai-compatible" as const) : ("cohere" as const),
    modelsUrl,
    modelListed: true,
    strictSchemaRequired: stage === "expansion" ? true : null,
    declaredEndpoints: null,
  });
  savePreflightState(
    {
      schemaVersion: 1,
      profiles: {
        default: {
          approval: { fingerprint, approvedAtMs: now },
          liveChecks: {
            expansion: {
              fingerprint,
              checkedAtMs: now,
              evidence: evidence("expansion", `${expansionEndpoint}/models`),
            },
            reranking: {
              fingerprint,
              checkedAtMs: now,
              evidence: evidence("reranking", "https://api.cohere.com/v1/models?page_size=1000"),
            },
          },
        },
      },
    },
    { filePath: join(configDirPath, "state.json") },
  );
}

const LITERAL_CONFIG = {
  version: 1,
  profiles: {
    literal: {
      expansion: { apiKey: SECRET },
    },
  },
} as const;

const DOCS = {
  "alpha.md": "# Alpha\n\nVector embeddings power semantic search.\n",
};

let index: TestIndex;
let configDir: string;
let literalConfigDir: string;
let configPath: string;
/**
 * The pipeline now really runs remote expansion for profile-backed queries
 * (ticket #10), so the fixture expansion endpoint points at a local stub
 * that answers with a deterministic original_sufficient response instead of
 * contacting the real provider.
 */
let expansionStubUrl: string;
let closeExpansionStub: () => Promise<void>;

function startExpansionStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  outcome: "original_sufficient",
                  queries: [],
                }),
              },
            },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function withConfigEnv(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...extra,
    QMDX_CONFIG_DIR: configDir,
    QMDX_TEST_EXPANSION_KEY: SECRET,
    QMDX_TEST_RERANKING_KEY: `${SECRET}-rerank`,
  };
}

function withLiteralConfigEnv(): NodeJS.ProcessEnv {
  return {
    QMDX_CONFIG_DIR: literalConfigDir,
    QMDX_TEST_EXPANSION_KEY: SECRET,
    QMDX_TEST_RERANKING_KEY: `${SECRET}-rerank`,
  };
}

beforeAll(async () => {
  const stub = await startExpansionStub();
  expansionStubUrl = stub.url;
  closeExpansionStub = stub.close;
  CONFIG.profiles.default.expansion.endpoint = expansionStubUrl;
  index = await createEmbeddedTestIndex(DOCS);
  configDir = mkdtempSync(join(tmpdir(), "qmdx-profiles-cli-"));
  configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify(CONFIG), "utf8");
  literalConfigDir = mkdtempSync(join(tmpdir(), "qmdx-profiles-literal-"));
  writeFileSync(
    join(literalConfigDir, "config.json"),
    JSON.stringify(LITERAL_CONFIG),
    "utf8",
  );
  seedDefaultProfilePreflight(configDir);
}, 240000);

afterAll(async () => {
  await closeExpansionStub();
  void index;
  void configDir;
  void literalConfigDir;
});

describe("profile configuration through the CLI", () => {
  it("uses the configured default profile when no --profile is supplied", async () => {
    const run = await runCli(
      ["query", "embeddings", "--format", "json"],
      index.root,
      { env: withConfigEnv(), fakeEmbedDimension: 8 },
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.results.length).toBeGreaterThan(0);
  });

  it("selects an explicit --profile and still completes locally", async () => {
    const run = await runCli(
      ["query", "embeddings", "--format", "json", "--profile", "default"],
      index.root,
      { env: withConfigEnv(), fakeEmbedDimension: 8 },
    );
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.results.length).toBeGreaterThan(0);
  });

  it("rejects an unconfigured profile name as invalid_profile at exit 2", async () => {
    const run = await runCli(
      ["query", "term", "--format", "json", "--profile", "enterprise"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error).toMatchObject({
      category: "configuration",
      code: "invalid_profile",
      stage: null,
      retryable: false,
    });
  });

  it("fails with missing_credentials when the declared env variable is unset", async () => {
    const env = withConfigEnv();
    delete env.QMDX_TEST_RERANKING_KEY;
    const run = await runCli(
      ["query", "term", "--format", "json"],
      index.root,
      { env: env },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error).toMatchObject({
      category: "configuration",
      code: "missing_credentials",
      stage: null,
    });
    expect(envelope.error.message).toContain("QMDX_TEST_RERANKING_KEY");
  });

  it("rejects literal credentials stored in profile content without echoing them", async () => {
    const run = await runCli(
      ["query", "term", "--format", "json", "--profile", "literal"],
      index.root,
      { env: withLiteralConfigEnv() },
    );
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("invalid_profile");
    expect(run.stderr).not.toContain(SECRET);
    expect(run.stdout).not.toContain(SECRET);
  });

  it("never exposes the resolved credential in results, errors, or diagnostics", async () => {
    const ok = await runCli(
      ["query", "embeddings", "--format", "json", "--explain", "--full"],
      index.root,
      { env: withConfigEnv(), fakeEmbedDimension: 8 },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toContain(SECRET);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(`${SECRET}-rerank`);

    const failing = await runCli(
      ["query", "term", "--format", "json", "--profile", "nope"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(failing.status).toBe(2);
    expect(failing.stderr).not.toContain(SECRET);
  });
});

describe("setup and doctor profile wiring", () => {
  it("setup resolves the default profile and prints only the env-var name", async () => {
    const run = await runCli(["setup"], index.root, {
      env: withConfigEnv(),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("credentialEnv=QMDX_TEST_EXPANSION_KEY");
    expect(run.stdout).toContain("provider=openai");
    expect(run.stdout).not.toContain(SECRET);
  });

  it("doctor accepts --profile and reports both routes", async () => {
    const run = await runCli(
      ["doctor", "--profile", "default"],
      index.root,
      { env: withConfigEnv(), fakeEmbedDimension: 8 },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("doctor expansion:");
    expect(run.stdout).toContain("doctor reranking:");
    expect(run.stdout).toContain("rerank-v4.0-pro");
    expect(run.stdout).not.toContain(SECRET);
  });

  it("setup fails closed on invalid profiles or missing credentials", async () => {
    const badProfile = await runCli(
      ["setup", "--profile", "enterprise"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(badProfile.status).toBe(2);
    expect(badProfile.stderr.startsWith("qmdx:")).toBe(true);

    const env = withConfigEnv();
    delete env.QMDX_TEST_EXPANSION_KEY;
    const noCreds = await runCli(["setup"], index.root, { env });
    expect(noCreds.status).toBe(2);
    expect(noCreds.stderr).toContain("is not set");
    expect(noCreds.stderr).toContain("QMDX_TEST_EXPANSION_KEY");
    expect(noCreds.stderr).not.toContain(SECRET);
  });

  it("rejects unsupported setup/doctor options as invocation errors", async () => {
    const run = await runCli(["doctor", "--all"], index.root, { env: withConfigEnv() });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unsupported option \"--all\"");
  });
});
