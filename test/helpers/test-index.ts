import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CollectionConfig, QMDStore } from "@tobilu/qmd";
import { createStore } from "@tobilu/qmd";
import { stringify } from "yaml";

export const REQUIRED_EMBED_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

process.env.QMD_CONFIG_DIR = mkdtempSync(join(tmpdir(), "qmdx-test-config-"));

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BIN_PATH = join(REPO_ROOT, "dist", "bin", "qmdx.js");

const FAKE_EMBED_PRELOAD_URL = pathToFileURL(
  fileURLToPath(new URL("./fake-embed.mjs", import.meta.url)),
).href;

export interface TestIndex {
  root: string;
  docsDir: string;
  configPath: string;
  dbPath: string;
  docidsByFile: Map<string, string>;
}

async function buildTestIndex(
  files: Record<string, string>,
  embedModel: string,
  afterUpdate?: (store: QMDStore) => Promise<unknown>,
): Promise<TestIndex> {
  const root = mkdtempSync(join(tmpdir(), "qmdx-index-"));
  const docsDir = join(root, "docs");
  const qmdDir = join(root, ".qmd");
  mkdirSync(docsDir);
  mkdirSync(qmdDir);

  const collectionConfig = {
    docs: { path: docsDir.split("\\").join("/"), pattern: "**/*.md" },
  };
  const config = {
    collections: collectionConfig,
    models: { embed: embedModel },
  } satisfies Partial<CollectionConfig> as CollectionConfig;

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(docsDir, name), content);
  }

  let store: QMDStore | null = null;
  try {
    store = await createStore({ dbPath: join(qmdDir, "index.sqlite"), config });
    await store.update();
    if (afterUpdate) {
      await afterUpdate(store);
    }
  } finally {
    store?.close();
  }

  const configYaml = stringify(config);
  writeFileSync(join(qmdDir, "index.yaml"), configYaml);

  return {
    root,
    docsDir,
    configPath: join(qmdDir, "index.yaml"),
    dbPath: join(qmdDir, "index.sqlite"),
    docidsByFile: await lookupDocids(join(qmdDir, "index.sqlite")),
  };
}

export async function createTestIndex(
  files: Record<string, string>,
): Promise<TestIndex> {
  return buildTestIndex(files, REQUIRED_EMBED_MODEL);
}

export interface EmbeddedTestIndexOptions {
  /** Deterministic fake vector width used for embeddings and probes. */
  dimension?: number;
  /** Embedding model recorded in the index config; defaults to the multilingual profile. */
  embedModel?: string;
}

/**
 * Build a controlled index and embed every document offline using the
 * deterministic fake-embed seam, so coverage checks see a complete index
 * without any local GGUF model.
 */
export async function createEmbeddedTestIndex(
  files: Record<string, string>,
  options: EmbeddedTestIndexOptions = {},
): Promise<TestIndex> {
  const { installFakeEmbed, restoreFakeEmbed } = await import(
    "./fake-embed.mjs"
  );
  const restore = await installFakeEmbed({
    dimension: options.dimension ?? 8,
  });
  try {
    return await buildTestIndex(
      files,
      options.embedModel ?? REQUIRED_EMBED_MODEL,
      (store) => store.embed(),
    );
  } finally {
    await restore();
  }
}

/**
 * Add documents to an existing test index and refresh the lexical index
 * without embedding them, so the added documents count as incomplete
 * embedding coverage.
 */
export async function addToTestIndex(
  index: TestIndex,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(index.docsDir, name), content);
  }
  let store: QMDStore | null = null;
  try {
    store = await createStore({ dbPath: index.dbPath });
    await store.update();
  } finally {
    store?.close();
  }
}

async function lookupDocids(dbPath: string): Promise<Map<string, string>> {
  let store: QMDStore | null = null;
  try {
    store = await createStore({ dbPath });
    const found = await store.multiGet("**/*");
    return new Map(
      found.docs
        .filter((entry) => !entry.skipped)
        .map((entry) => [
          entry.doc.displayPath.split("/").pop()!,
          entry.doc.docid,
        ]),
    );
  } finally {
    store?.close();
  }
}

export interface RunCliOptions {
  /** Additional environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Launch the child with the deterministic fake-embed preload active at the
   * given vector width. Use a different width than the index was built with
   * to force vector-probe dimension incompatibility.
   */
  fakeEmbedDimension?: number;
}

export interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI as a child process and resolves when it exits. Uses
 * asynchronous spawn (not spawnSync) so the test worker's event loop stays
 * responsive while the child runs; tests that stub provider HTTP servers
 * inside the worker depend on this to answer the child's requests.
 */
export function runCli(
  args: readonly string[],
  cwd: string,
  options: RunCliOptions = {},
): Promise<CliRunResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  if (options.fakeEmbedDimension !== undefined) {
    childEnv.NODE_OPTIONS = `--import ${FAKE_EMBED_PRELOAD_URL}`;
    childEnv.QMDX_TEST_FAKE_EMBED_DIM = String(options.fakeEmbedDimension);
  }
  Object.assign(childEnv, options.env ?? {});

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`CLI run timed out after 60000ms: qmdx ${args.join(" ")}`));
      }
    }, 60000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      }
    });
  });
}
