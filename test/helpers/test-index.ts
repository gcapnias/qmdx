import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CollectionConfig, QMDStore } from "@tobilu/qmd";
import { createStore } from "@tobilu/qmd";
import { stringify } from "yaml";

export const REQUIRED_EMBED_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

process.env.QMD_CONFIG_DIR = mkdtempSync(join(tmpdir(), "qmdx-test-config-"));

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BIN_PATH = join(REPO_ROOT, "dist", "bin", "qmdx.js");

export interface TestIndex {
  root: string;
  docsDir: string;
  configPath: string;
  dbPath: string;
  docidsByFile: Map<string, string>;
}

export async function createTestIndex(
  files: Record<string, string>,
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
    models: { embed: REQUIRED_EMBED_MODEL },
  } satisfies Partial<CollectionConfig> as CollectionConfig;

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(docsDir, name), content);
  }

  let store: QMDStore | null = null;
  try {
    store = await createStore({ dbPath: join(qmdDir, "index.sqlite"), config });
    await store.update();
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

export function runCli(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
