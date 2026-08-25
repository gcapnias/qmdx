import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
import { fingerprintPrivacyDeclaration, type PrivacyDeclaration } from "../src/preflight/privacy.js";
import { savePreflightState } from "../src/preflight/state.js";

const SECRET = "sk-qmdx-preflight-stub-secret";
const EXPANSION_MODEL = "gpt-4o-mini";
const RERANKING_MODEL = "rerank-v4.0-pro";

const DECLARATION: PrivacyDeclaration = {
  declarationVersion: 3,
  endpoint: "http://127.0.0.1 (local stub)",
  region: "eu",
  stagePayloads: {
    expansion: "The original query text only.",
    reranking: "Selected chunks plus a request-local correlation id.",
  },
  retention: "Zero retention.",
  trainingUse: "Excluded from provider training.",
  reviewedSources: ["https://example.com/stub-policy"],
};

interface StubRequestLogEntry {
  path: string;
  hasAuthHeader: boolean;
  bodyBytes: number;
}

interface StubServer {
  server: Server;
  url: string;
  requests: StubRequestLogEntry[];
}

function startStub(
  behavior: (req: IncomingMessage) => { status: number; body: unknown },
): Promise<StubServer> {
  return new Promise((resolve) => {
    const requests: StubRequestLogEntry[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          hasAuthHeader: typeof req.headers.authorization === "string",
          bodyBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
        });
        const { status, body } = behavior(req);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function catalogResponse(): { status: number; body: unknown } {
  return {
    status: 200,
    body: { data: [{ id: EXPANSION_MODEL }], models: [{ name: RERANKING_MODEL }] },
  };
}

let index: TestIndex;
let openaiStub: StubServer;
let authFailStub: StubServer;
let noRerankStub: StubServer;

function writeProfileConfig(
  configDir: string,
  overrides: Record<string, unknown> = {},
): void {
  const config = {
    version: 1,
    defaultProfile: "default",
    profiles: {
      default: {
        expansion: {
          provider: "openai",
          endpoint: `${openaiStub.url}/v1`,
          model: EXPANSION_MODEL,
          credentialEnv: "QMDX_TEST_EXPANSION_KEY",
        },
        reranking: {
          provider: "cohere",
          endpoint: openaiStub.url,
          model: RERANKING_MODEL,
          credentialEnv: "QMDX_TEST_RERANKING_KEY",
        },
        privacy: { declaration: DECLARATION },
        ...overrides,
      },
    },
  };
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config), "utf8");
}

function newConfigDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `qmdx-preflight-cli-${label}-`));
}

function childEnv(
  configDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    QMDX_CONFIG_DIR: configDir,
    QMDX_TEST_EXPANSION_KEY: SECRET,
    QMDX_TEST_RERANKING_KEY: `${SECRET}-rerank`,
    ...extra,
  };
}

function currentFingerprint(): string {
  return computeProfilePreflightFingerprint({
    expansion: {
      provider: "openai",
      endpoint: `${openaiStub.url}/v1`,
      model: EXPANSION_MODEL,
      credentialEnv: "QMDX_TEST_EXPANSION_KEY",
    },
    reranking: {
      provider: "cohere",
      endpoint: openaiStub.url,
      model: RERANKING_MODEL,
      credentialEnv: "QMDX_TEST_RERANKING_KEY",
    },
    expansionPricing: reviewedProviderPricing.rateFor("openai", EXPANSION_MODEL),
    rerankingPricing: reviewedProviderPricing.rateFor("cohere", RERANKING_MODEL),
    privacyDeclarationFingerprint: fingerprintPrivacyDeclaration(DECLARATION),
  });
}

function seedState(
  configDir: string,
  checkedAtMs: number,
  fingerprint = currentFingerprint(),
): void {
  const evidence = (stage: "expansion" | "reranking") => ({
    stage,
    providerKind: stage === "expansion" ? ("openai-compatible" as const) : ("cohere" as const),
    modelsUrl: "stub://models",
    modelListed: true,
    strictSchemaRequired: null,
    declaredEndpoints: null,
  });
  savePreflightState(
    {
      schemaVersion: 1,
      profiles: {
        default: {
          approval: { fingerprint, approvedAtMs: checkedAtMs },
          liveChecks: {
            expansion: { fingerprint, checkedAtMs, evidence: evidence("expansion") },
            reranking: { fingerprint, checkedAtMs, evidence: evidence("reranking") },
          },
        },
      },
    },
    { filePath: join(configDir, "state.json") },
  );
}

beforeAll(async () => {
  index = await createEmbeddedTestIndex({
    "alpha.md": "# Alpha\n\nVector embeddings power semantic search.\n",
  });
  openaiStub = await startStub(() => catalogResponse());
  authFailStub = await startStub(() => ({ status: 401, body: {} }));
  noRerankStub = await startStub(() => ({
    status: 200,
    body: { data: [], models: [{ name: RERANKING_MODEL, endpoints: ["embed"] }] },
  }));
}, 240000);

afterAll(() => {
  openaiStub?.server.close();
  authFailStub?.server.close();
  noRerankStub?.server.close();
});

describe("first-use fail-closed behavior", () => {
  it("fails a query with privacy_approval_required and transmits nothing", async () => {
    const configDir = newConfigDir("closed");
    writeProfileConfig(configDir);
    const beforeExpansion = openaiStub.requests.length;

    const run = await runCli(["query", "embeddings", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error).toMatchObject({
      category: "configuration",
      code: "privacy_approval_required",
      stage: null,
      retryable: false,
    });
    // No search payload reached either provider stub.
    expect(openaiStub.requests.length).toBe(beforeExpansion);
  });

  it("refuses non-interactive setup that cannot obtain explicit approval", async () => {
    const configDir = newConfigDir("noninteractive");
    writeProfileConfig(configDir);
    const run = await runCli(["setup", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("privacy_approval_required");
    expect(run.stdout).not.toContain('"status": "ok"');
  });

  it("records nothing when the user declines the approval prompt", async () => {
    const configDir = newConfigDir("declined");
    writeProfileConfig(configDir);
    const declined = await runCli(["setup", "--format", "json"], index.root, {
      env: childEnv(configDir, { QMDX_APPROVAL_INPUT: "no" }),
      fakeEmbedDimension: 8,
    });
    expect(declined.status).toBe(2);
    expect(JSON.parse(declined.stderr as string)).toMatchObject({
      error: { code: "privacy_approval_required" },
    });

    const followUp = await runCli(["query", "embeddings", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(followUp.status).toBe(2);
    expect(JSON.parse(followUp.stderr).error.code).toBe("privacy_approval_required");
  });
});

describe("interactive approval through the automation seam", () => {
  it("setup approves, records state, and later queries succeed offline", async () => {
    const configDir = newConfigDir("approved");
    writeProfileConfig(configDir);

    const setupRun = await runCli(["setup", "--format", "json"], index.root, {
      env: childEnv(configDir, { QMDX_APPROVAL_INPUT: "approve" }),
      fakeEmbedDimension: 8,
    });
    expect(setupRun.status).toBe(0);
    expect(setupRun.stdout).toContain('"command": "setup"');
    const diagnostics = JSON.parse(setupRun.stdout) as {
      routes?: { approval: { current: boolean }; stages: Record<string, unknown> };
    };
    expect(diagnostics.routes?.approval.current).toBe(true);

    // The authenticated capability checks hit both stub catalogs with
    // bearer credentials and empty bodies.
    const catalogRequests = openaiStub.requests.filter(
      (entry) => entry.path.includes("/models") && entry.hasAuthHeader,
    );
    expect(catalogRequests.length).toBeGreaterThanOrEqual(2);
    expect(catalogRequests.every((entry) => entry.bodyBytes === 0)).toBe(true);

    const queryRun = await runCli(["query", "embeddings", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(queryRun.status).toBe(0);
    const envelope = JSON.parse(queryRun.stdout) as ResultEnvelope;
    expect(envelope.results.length).toBeGreaterThan(0);
    expect(`${queryRun.stdout}${queryRun.stderr}`).not.toContain(SECRET);
  });
});

describe("live-check validity windows", () => {
  it("accepts a 25-hour-old check normally but rejects it for strict required-remote runs", async () => {
    const configDir = newConfigDir("strict");
    writeProfileConfig(configDir);
    seedState(configDir, Date.now() - 25 * 60 * 60 * 1000);

    const normal = await runCli(["query", "embeddings", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(normal.status).toBe(0);

    const strict = await runCli(
      ["query", "embeddings", "--format", "json", "--require-remote"],
      index.root,
      { env: childEnv(configDir), fakeEmbedDimension: 8 },
    );
    expect(strict.status).toBe(2);
    const envelope = JSON.parse(strict.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("preflight_required");
    expect(envelope.error.message).toContain("24 hours");
  });

  it("rejects an 8-day-old check even for normal use", async () => {
    const configDir = newConfigDir("expired");
    writeProfileConfig(configDir);
    seedState(configDir, Date.now() - 8 * 24 * 60 * 60 * 1000);

    const run = await runCli(["query", "embeddings", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("preflight_required");
    expect(envelope.error.message).toContain("7 days");
  });
});

describe("invalidation of approval by route changes", () => {
  it("voids approval when the credential reference changes", async () => {
    const configDir = newConfigDir("invalidated");
    writeProfileConfig(configDir);
    seedState(configDir, Date.now());

    writeProfileConfig(configDir, {
      expansion: {
        provider: "openai",
        endpoint: `${openaiStub.url}/v1`,
        model: EXPANSION_MODEL,
        credentialEnv: "QMDX_TEST_EXPANSION_KEY_ALT",
      },
    });

    const run = await runCli(["query", "embeddings", "--format", "json"], index.root, {
      env: childEnv(configDir, { QMDX_TEST_EXPANSION_KEY_ALT: SECRET }),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stderr).error.code).toBe("privacy_approval_required");
  });
});

describe("authenticated live check failures during setup", () => {
  it("reports failed authentication without echoing the credential", async () => {
    const configDir = newConfigDir("authfail");
    const address = authFailStub.url;
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        version: 1,
        defaultProfile: "default",
        profiles: {
          default: {
            expansion: {
              provider: "openai",
              endpoint: `${address}/v1`,
              model: EXPANSION_MODEL,
              credentialEnv: "QMDX_TEST_EXPANSION_KEY",
            },
            reranking: {
              provider: "cohere",
              endpoint: openaiStub.url,
              model: RERANKING_MODEL,
              credentialEnv: "QMDX_TEST_RERANKING_KEY",
            },
            privacy: { declaration: DECLARATION },
          },
        },
      }),
      "utf8",
    );

    const run = await runCli(["setup", "--format", "json"], index.root, {
      env: childEnv(configDir, { QMDX_APPROVAL_INPUT: "approve" }),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error).toMatchObject({
      category: "configuration",
      code: "preflight_required",
      retryable: false,
    });
    expect(envelope.error.message.toLowerCase()).toContain("authentication");
    expect(run.stderr).not.toContain(SECRET);
  });

  it("rejects a rerank model whose catalog entry lacks the rerank endpoint", async () => {
    const configDir = newConfigDir("norank");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        version: 1,
        defaultProfile: "default",
        profiles: {
          default: {
            expansion: {
              provider: "openai",
              endpoint: `${openaiStub.url}/v1`,
              model: EXPANSION_MODEL,
              credentialEnv: "QMDX_TEST_EXPANSION_KEY",
            },
            reranking: {
              provider: "cohere",
              endpoint: noRerankStub.url,
              model: RERANKING_MODEL,
              credentialEnv: "QMDX_TEST_RERANKING_KEY",
            },
            privacy: { declaration: DECLARATION },
          },
        },
      }),
      "utf8",
    );

    const run = await runCli(["setup", "--format", "json"], index.root, {
      env: childEnv(configDir),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
    expect(envelope.error).toMatchObject({
      category: "configuration",
      code: "invalid_profile",
    });
    expect(envelope.error.message).toContain("rerank");
  });
});
