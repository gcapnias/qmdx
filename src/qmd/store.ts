import { readFileSync } from "node:fs";
import { createStore } from "@tobilu/qmd";
import type { CollectionConfig, QMDStore } from "@tobilu/qmd";
import { parse } from "yaml";
import { localIndexUnavailableError } from "../core/errors.js";
import type { ProjectIndexLocation } from "./paths.js";

export const REQUIRED_EMBED_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

interface RawProjectConfig {
  collections?: Record<string, unknown>;
  models?: { embed?: string; rerank?: string; generate?: string };
}

export interface OpenedProjectStore {
  store: QMDStore;
  /** The effective embedding model explicitly configured for this open. */
  embedModel: string;
  /** True when the effective profile is the approved multilingual default. */
  multilingualDefault: boolean;
}

export async function openProjectStore(
  location: ProjectIndexLocation,
): Promise<OpenedProjectStore> {
  let raw: RawProjectConfig;
  try {
    raw = parse(readFileSync(location.configPath, "utf8")) as RawProjectConfig;
  } catch (cause) {
    throw localIndexUnavailableError(
      `Cannot read QMD index configuration at ${location.configPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const configuredEmbed = raw.models?.embed;
  const embedModel = configuredEmbed ?? REQUIRED_EMBED_MODEL;

  const config = {
    collections: (raw.collections ?? {}) as CollectionConfig["collections"],
    models: {
      ...raw.models,
      embed: embedModel,
    },
  } satisfies Partial<CollectionConfig> as CollectionConfig;

  let store: QMDStore;
  try {
    store = await createStore({ dbPath: location.dbPath, config });
  } catch (cause) {
    throw localIndexUnavailableError(
      `Cannot open QMD index at ${location.dbPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  return {
    store,
    embedModel,
    multilingualDefault:
      configuredEmbed === undefined || configuredEmbed === REQUIRED_EMBED_MODEL,
  };
}
