import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import type { QMDStore } from "@tobilu/qmd";
import { createStore } from "@tobilu/qmd";
import {
  createTestIndex,
  runCli,
  type TestIndex,
} from "./helpers/test-index.js";
import type { ErrorEnvelope, ResultEnvelope } from "../src/core/envelope.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";

const REPRESENTATIVE_DOCS: Record<string, string> = {
  "alpha.md":
    "# Alpha\n\nVector embeddings power semantic search across languages.\n",
  "beta.md":
    "# Beta\n\nVector search blends lexical and semantic signals for ranking.\n",
  "gamma.md":
    "# Gamma\n\nGrafana dashboards track latency metrics across regions.\n",
  "notes-el.md":
    "# Σημειώσεις\n\nΔιανυσματικά embeddings υποστηρίζουν σημασιολογική αναζήτηση.\n",
};

const INSTALL_SCRIPT_TIMEOUT_MS = 900000;

let index: TestIndex;
let installDirs: string[] = [];

beforeAll(async () => {
  index = await createTestIndex(REPRESENTATIVE_DOCS);
}, 600000);

afterAll(() => {
  for (const dir of installDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface InstalledPackage {
  /** dist/bin/qmdx.js inside the installed copy of @gcapnias/qmdx. */
  binJs: string;
  /** Platform .bin shim that global/npx/local installs expose as `qmdx`. */
  shim: string;
}

function sanitizedNpmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function runNpm(
  args: readonly string[],
  options: { cwd: string; timeout: number },
): SpawnSyncReturns<string> {
  return spawnSync(NPM, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout,
    stdio: ["ignore", "pipe", "pipe"],
    shell: IS_WINDOWS,
    env: sanitizedNpmEnv(),
  });
}

function installPackedPackage(): InstalledPackage {
  const packed = runNpm(["pack", "--json"], {
    cwd: REPO_ROOT,
    timeout: INSTALL_SCRIPT_TIMEOUT_MS,
  });
  expect(
    packed.status,
    `npm pack failed:\n${packed.stdout}\n${packed.stderr}`,
  ).toBe(0);
  const parsed = JSON.parse(packed.stdout) as
    | Array<{ filename: string }>
    | Record<string, { filename: string }>;
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const filename = entries.at(-1)?.filename;
  expect(filename, "npm pack produced a tarball").toBeTruthy();
  const tarballPath = join(REPO_ROOT, filename!);

  const projectDir = mkdtempSync(join(tmpdir(), "qmdx-pack-smoke-"));
  installDirs.push(projectDir);
  const repoPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { allowScripts: Record<string, boolean> };
  const pkg = {
    name: "qmdx-pack-smoke",
    private: true,
    version: "0.0.0",
    allowScripts: { ...repoPkg.allowScripts },
  };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg));

  const install = runNpm(
    [
      "install",
      tarballPath,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: projectDir, timeout: INSTALL_SCRIPT_TIMEOUT_MS },
  );
  expect(
    install.status,
    `npm install failed:\n${install.stdout}\n${install.stderr}`,
  ).toBe(0);

  const binJs = join(
    projectDir,
    "node_modules",
    "@gcapnias",
    "qmdx",
    "dist",
    "bin",
    "qmdx.js",
  );
  expect(existsSync(binJs), `installed bin exists at ${binJs}`).toBe(true);
  const shimName = IS_WINDOWS ? "qmdx.cmd" : "qmdx";
  const shim = join(projectDir, "node_modules", ".bin", shimName);
  expect(existsSync(shim), `install created the ${shimName} shim`).toBe(true);
  return { binJs, shim };
}

function runInstalledCli(
  installed: InstalledPackage,
  args: readonly string[],
  cwd: string,
): ReturnType<typeof runCli> {
  return runCli(args, cwd, { binPath: installed.binJs });
}

async function sdkDocids(dbPath: string): Promise<Map<string, string>> {
  let store: QMDStore | null = null;
  try {
    store = await createStore({ dbPath });
    const found = await store.multiGet("**/*");
    return new Map(
      found.docs
        .filter((entry) => !entry.skipped)
        .map((entry) => [entry.doc.displayPath.split("/").pop()!, entry.doc.docid]),
    );
  } finally {
    store?.close();
  }
}

describe("pack-and-run smoke: packaged CLI passes the child-process contract", () => {
  let installed: InstalledPackage;

  beforeAll(() => {
    installed = installPackedPackage();
  }, INSTALL_SCRIPT_TIMEOUT_MS);

  it(
    "exposes the qmdx executable through the install shim (global/npx/local surface)",
    () => {
      const result = spawnSync(installed.shim, ["query", "--help"], {
        cwd: index.root,
        encoding: "utf8",
        shell: IS_WINDOWS,
        timeout: 120000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: qmdx");
    },
    180000,
  );

  it(
    "returns one valid result envelope on stdout with empty stderr and exit 0",
    async () => {
      const run = await runInstalledCli(
        installed,
        ["query", "embeddings", "--format", "json"],
        index.root,
      );
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as ResultEnvelope;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.pipeline.retrieval).toMatchObject({
        status: "ok",
        engine: "qmd",
      });
      expect(envelope.results.length).toBeGreaterThan(0);
      expect(envelope.results[0]!.rank).toBe(1);
    },
    180000,
  );

  it(
    "reports degraded remote stages with closed warning codes while staying exit 0",
    async () => {
      const run = await runInstalledCli(
        installed,
        ["query", "embeddings", "--format", "json"],
        index.root,
      );
      const envelope = JSON.parse(run.stdout) as ResultEnvelope;
      expect(envelope.pipeline.status).toBe("degraded");
      expect(envelope.pipeline.expansion.reason).toBe("provider_unavailable");
      const codes = envelope.warnings.map((warning) => warning.code);
      expect(codes).toContain("provider_unavailable");
    },
    180000,
  );

  it(
    "renders human output identical in shape to the development executable",
    async () => {
      const run = await runInstalledCli(
        installed,
        ["query", "embeddings"],
        index.root,
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/^1\. /m);
      expect(run.stdout).toContain("qmd://docs/alpha.md");
      expect(run.stderr).toContain("Warning:");
    },
    180000,
  );

  it(
    "rejects unsupported options with exit 2 and an invocation error envelope",
    async () => {
      const run = await runInstalledCli(
        installed,
        ["query", "term", "--all", "--format", "json"],
        index.root,
      );
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
      expect(envelope.error).toMatchObject({
        category: "invocation",
        code: "unsupported_option",
      });
    },
    180000,
  );

  it(
    "fails local-retrieval with exit 3 when no project index exists",
    async () => {
      const bareDir = mkdtempSync(join(tmpdir(), "qmdx-pack-smoke-bare-"));
      installDirs.push(bareDir);
      const run = await runInstalledCli(
        installed,
        ["query", "term", "--format", "json"],
        bareDir,
      );
      expect(run.status).toBe(3);
      const envelope = JSON.parse(run.stderr) as ErrorEnvelope;
      expect(envelope.error.code).toBe("local_index_unavailable");
    },
    180000,
  );
});

describe("representative index installation and upgrade regression", () => {
  let installed: InstalledPackage;

  beforeAll(() => {
    installed = installPackedPackage();
  }, INSTALL_SCRIPT_TIMEOUT_MS);

  function writeExtraDoc(): void {
    writeFileSync(
      join(index.docsDir, "delta.md"),
      "# Delta\n\nMultilingual retrieval spans English and Greek corpora.\n",
    );
  }

  it(
    "matches public SDK identity for a freshly opened representative index after installation",
    async () => {
      const expected = await sdkDocids(index.dbPath);
      const run = await runInstalledCli(
        installed,
        ["query", "embeddings", "--format", "json", "--explain"],
        index.root,
      );
      expect(run.status).toBe(0);
      const envelope = JSON.parse(run.stdout) as ResultEnvelope;
      const alphaDocid = expected.get("alpha.md")!;
      expect(alphaDocid).toBeTruthy();
      const top = envelope.results.find((result) => result.title === "Alpha");
      expect(top).toBeTruthy();
      expect(top!.docid).toBe(`#${alphaDocid}`);
      expect(top!.file).toBe("qmd://docs/alpha.md");
    },
    240000,
  );

  it(
    "keeps identities stable across an index upgrade performed through the public SDK",
    async () => {
      const before = await sdkDocids(index.dbPath);

      let store: QMDStore | null = null;
      try {
        store = await createStore({ dbPath: index.dbPath });
        await store.update();
      } finally {
        store?.close();
      }

      const after = await sdkDocids(index.dbPath);
      for (const [file, docid] of before) {
        expect(after.get(file), `${file} keeps its docid`).toBe(docid);
      }

      writeExtraDoc();
      try {
        let upgradeStore: QMDStore | null = null;
        try {
          upgradeStore = await createStore({ dbPath: index.dbPath });
          await upgradeStore.update();
        } finally {
          upgradeStore?.close();
        }

        const upgraded = await sdkDocids(index.dbPath);
        expect(upgraded.has("delta.md")).toBe(true);
        for (const [file, docid] of before) {
          expect(upgraded.get(file), `${file} survives the upgrade`).toBe(docid);
        }

        const run = await runInstalledCli(
          installed,
          ["query", "multilingual", "--format", "json"],
          index.root,
        );
        expect(run.status).toBe(0);
        const envelope = JSON.parse(run.stdout) as ResultEnvelope;
        const deltaDocid = upgraded.get("delta.md")!;
        const delta = envelope.results.find((result) => result.docid === `#${deltaDocid}`);
        expect(delta).toBeTruthy();
      } finally {
        rmSync(join(index.docsDir, "delta.md"), { force: true });
      }
    },
    240000,
  );
});
