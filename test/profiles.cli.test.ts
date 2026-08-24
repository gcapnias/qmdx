import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmbeddedTestIndex,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import type { ErrorEnvelope, ResultEnvelope } from "../src/core/envelope.js";

const SECRET = "sk-qmdx-test-literal-secret-9f2a";

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
      privacy: {},
    },
  },
} as const;

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
}, 240000);

afterAll(() => {
  void index;
  void configDir;
  void literalConfigDir;
});

describe("profile configuration through the CLI", () => {
  it("uses the configured default profile when no --profile is supplied", () => {
    const run = runCli(
      ["query", "embeddings", "--format", "json"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.results.length).toBeGreaterThan(0);
  });

  it("selects an explicit --profile and still completes locally", () => {
    const run = runCli(
      ["query", "embeddings", "--format", "json", "--profile", "default"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as ResultEnvelope;
    expect(envelope.results.length).toBeGreaterThan(0);
  });

  it("rejects an unconfigured profile name as invalid_profile at exit 2", () => {
    const run = runCli(
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

  it("fails with missing_credentials when the declared env variable is unset", () => {
    const env = withConfigEnv();
    delete env.QMDX_TEST_RERANKING_KEY;
    const run = runCli(
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

  it("rejects literal credentials stored in profile content without echoing them", () => {
    const run = runCli(
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

  it("never exposes the resolved credential in results, errors, or diagnostics", () => {
    const ok = runCli(
      ["query", "embeddings", "--format", "json", "--explain", "--full"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toContain(SECRET);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(`${SECRET}-rerank`);

    const failing = runCli(
      ["query", "term", "--format", "json", "--profile", "nope"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(failing.status).toBe(2);
    expect(failing.stderr).not.toContain(SECRET);
  });
});

describe("setup and doctor profile wiring", () => {
  it("setup resolves the default profile and prints only the env-var name", () => {
    const run = runCli(["setup"], index.root, {
      env: withConfigEnv(),
      fakeEmbedDimension: 8,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("credentialEnv=QMDX_TEST_EXPANSION_KEY");
    expect(run.stdout).toContain("provider=openai");
    expect(run.stdout).not.toContain(SECRET);
  });

  it("doctor accepts --profile and reports both routes", () => {
    const run = runCli(
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

  it("setup fails closed on invalid profiles or missing credentials", () => {
    const badProfile = runCli(
      ["setup", "--profile", "enterprise"],
      index.root,
      { env: withConfigEnv() },
    );
    expect(badProfile.status).toBe(2);
    expect(badProfile.stderr.startsWith("qmdx:")).toBe(true);

    const env = withConfigEnv();
    delete env.QMDX_TEST_EXPANSION_KEY;
    const noCreds = runCli(["setup"], index.root, { env });
    expect(noCreds.status).toBe(2);
    expect(noCreds.stderr).toContain("is not set");
    expect(noCreds.stderr).toContain("QMDX_TEST_EXPANSION_KEY");
    expect(noCreds.stderr).not.toContain(SECRET);
  });

  it("rejects unsupported setup/doctor options as invocation errors", () => {
    const run = runCli(["doctor", "--all"], index.root, { env: withConfigEnv() });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unsupported option \"--all\"");
  });
});
