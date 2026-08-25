import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { invalidProfileConfigError } from "../core/errors.js";
import {
  validateConfig,
  type QmdxConfig,
} from "./schema.js";
import { userConfigFilePath } from "./location.js";

export interface ConfigStoreOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the config file path (test seam). */
  filePath?: string;
}

/**
 * Reads and validates the version-1 user configuration.
 * Returns null when no configuration file exists; throws a
 * configuration/invalid_profile QmdxError when the file exists but is
 * malformed, invalid, or written for another schema version.
 */
export function loadUserConfig(options: ConfigStoreOptions = {}): QmdxConfig | null {
  const filePath = options.filePath ?? userConfigFilePath(options.env);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw invalidProfileConfigError(
      `Configuration file ${filePath} could not be read.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidProfileConfigError(
      `Configuration file ${filePath} is not valid JSON.`,
    );
  }
  validateConfig(parsed);
  return parsed;
}

/**
 * Validates and writes the version-1 user configuration. The write is atomic
 * (temp file plus rename) and never stores credentials; validation rejects
 * any literal-credential-shaped content before touching disk.
 */
export function saveUserConfig(
  config: QmdxConfig,
  options: ConfigStoreOptions = {},
): string {
  validateConfig(config);
  const filePath = options.filePath ?? userConfigFilePath(options.env);
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.config-${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
  return filePath;
}
