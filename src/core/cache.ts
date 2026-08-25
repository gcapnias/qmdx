import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { invalidProfileConfigError } from "./errors.js";

/**
 * Opt-in bounded remote-response caches (docs/spec/qmdx-v1.md, "Caching and
 * diagnostics"): disabled by default, independently configurable per stage,
 * bounded in entries and TTL, and persisted with owner-only permissions.
 *
 * The generic store here never decides WHAT is cached or how identity is
 * computed; each stage owns its identity (stage inputs or hashes plus route,
 * prompt/schema, privacy declaration, and policy versions) and stores only
 * validated provider results — never credentials and never selected chunks.
 */

export const CACHE_ENTRY_SCHEMA_VERSION = 1;

/** Bumped whenever cache-identity semantics change outcome-affecting ways. */
export const CACHE_IDENTITY_VERSION = 1;

/** Default entry bound per stage cache when a profile enables it. */
export const DEFAULT_CACHE_MAX_ENTRIES = 128;

/** Default TTL in seconds (7 days) when a profile enables a stage cache. */
export const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface StageCacheSettings {
  enabled: boolean;
  maxEntries: number;
  ttlSeconds: number;
}

export interface CachePolicy {
  expansion: StageCacheSettings;
  reranking: StageCacheSettings;
}

const CREDENTIAL_FIELD_NAME =
  /pass(word)?|secret|token|api[-_]?key|credential|auth|private[-_]?key/i;

function parseStageCacheSettings(
  value: unknown,
  context: string,
): StageCacheSettings {
  if (value === undefined) {
    return {
      enabled: false,
      maxEntries: DEFAULT_CACHE_MAX_ENTRIES,
      ttlSeconds: DEFAULT_CACHE_TTL_SECONDS,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidProfileConfigError(
      `${context} must be a JSON object.`,
    );
  }
  const fields = value as Record<string, unknown>;
  let enabled = false;
  let maxEntries = DEFAULT_CACHE_MAX_ENTRIES;
  let ttlSeconds = DEFAULT_CACHE_TTL_SECONDS;
  for (const [key, fieldValue] of Object.entries(fields)) {
    if (CREDENTIAL_FIELD_NAME.test(key)) {
      throw invalidProfileConfigError(
        `${context} field "${key}" looks like a literal credential; QMDX configuration never stores credentials.`,
      );
    }
    switch (key) {
      case "enabled":
        if (typeof fieldValue !== "boolean") {
          throw invalidProfileConfigError(
            `${context} field "enabled" must be a boolean.`,
          );
        }
        enabled = fieldValue;
        break;
      case "maxEntries":
        if (
          typeof fieldValue !== "number" ||
          !Number.isInteger(fieldValue) ||
          fieldValue < 1 ||
          fieldValue > 10_000
        ) {
          throw invalidProfileConfigError(
            `${context} field "maxEntries" must be an integer from 1 through 10000.`,
          );
        }
        maxEntries = fieldValue;
        break;
      case "ttlSeconds":
        if (
          typeof fieldValue !== "number" ||
          !Number.isInteger(fieldValue) ||
          fieldValue < 1 ||
          fieldValue > 366 * 24 * 60 * 60
        ) {
          throw invalidProfileConfigError(
            `${context} field "ttlSeconds" must be an integer from 1 through ${366 * 24 * 60 * 60}.`,
          );
        }
        ttlSeconds = fieldValue;
        break;
      default:
        throw invalidProfileConfigError(
          `${context} has unknown field "${key}".`,
        );
    }
  }
  return { enabled, maxEntries, ttlSeconds };
}

/**
 * Parses the `cache` section of a profile's `policy` object:
 * `{ "cache": { "expansion": {...}, "reranking": {...} } }`. Both stages
 * default to disabled with conservative bounds; unknown fields and
 * credential-shaped keys are rejected before anything persists.
 */
export function parseCachePolicy(
  policySection: unknown,
  context: string,
): CachePolicy {
  const label = `${context} policy`;
  if (policySection === undefined) {
    return {
      expansion: parseStageCacheSettings(undefined, label),
      reranking: parseStageCacheSettings(undefined, label),
    };
  }
  if (typeof policySection !== "object" || policySection === null || Array.isArray(policySection)) {
    throw invalidProfileConfigError(`${label} section must be a JSON object.`);
  }
  const cache = (policySection as Record<string, unknown>).cache;
  if (cache === undefined) {
    return {
      expansion: parseStageCacheSettings(undefined, label),
      reranking: parseStageCacheSettings(undefined, label),
    };
  }
  if (typeof cache !== "object" || cache === null || Array.isArray(cache)) {
    throw invalidProfileConfigError(
      `${label} field "cache" must be a JSON object.`,
    );
  }
  const stages = cache as Record<string, unknown>;
  for (const key of Object.keys(stages)) {
    if (key !== "expansion" && key !== "reranking") {
      throw invalidProfileConfigError(
        `${label} cache has unknown stage "${key}".`,
      );
    }
  }
  return {
    expansion: parseStageCacheSettings(stages.expansion, `${label} cache expansion`),
    reranking: parseStageCacheSettings(stages.reranking, `${label} cache reranking`),
  };
}

interface StoredEntry {
  schemaVersion: number;
  identityHash: string;
  storedAtMs: number;
  expiresAtMs: number;
  response: unknown;
}

/**
 * The seam a remote stage reads to consult and populate its persistent
 * response cache. Responses are opaque JSON values owned by the stage.
 */
export interface ResponseStore {
  /** Returns the cached response for the identity, or null on any miss. */
  get(identityHash: string): unknown | null;
  /** Persists a validated response under the identity hash. */
  put(identityHash: string, response: unknown): void;
}

/**
 * Everything a remote stage needs to use its cache: the store plus the
 * fingerprint of the privacy declaration in force, which participates in
 * every identity so entries never survive a declaration change.
 */
export interface StageCacheBinding {
  store: ResponseStore;
  privacyFingerprint: string;
}

export interface FileResponseStoreOptions {
  directory: string;
  maxEntries: number;
  ttlMs: number;
  clock?: Clock;
}

function ownerOnlyDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

/**
 * File-backed response store: one JSON file per identity inside a
 * dedicated directory, written atomically with owner-only permissions
 * (0o700 directory, 0o600 files). Bounded by maxEntries and ttlMs; expired
 * entries and least-recently-stored entries beyond the bound are evicted.
 * Any unreadable or stale byte content is treated as a miss, never trusted.
 */
export function createFileResponseStore(
  options: FileResponseStoreOptions,
): ResponseStore {
  const clock = options.clock ?? systemClock;
  const { directory, maxEntries, ttlMs } = options;

  const pathFor = (identityHash: string) => join(directory, `${identityHash}.json`);

  function readEntry(identityHash: string): StoredEntry | null {
    let raw: string;
    try {
      raw = readFileSync(pathFor(identityHash), "utf8");
    } catch {
      return null;
    }
    let entry: StoredEntry;
    try {
      const parsed = JSON.parse(raw) as StoredEntry;
      if (
        parsed.schemaVersion !== CACHE_ENTRY_SCHEMA_VERSION ||
        parsed.identityHash !== identityHash ||
        typeof parsed.storedAtMs !== "number" ||
        typeof parsed.expiresAtMs !== "number" ||
        !Number.isFinite(parsed.storedAtMs)
      ) {
        return null;
      }
      entry = parsed;
    } catch {
      return null;
    }
    if (entry.expiresAtMs <= clock.nowMs()) return null;
    return entry;
  }

  function evict(): void {
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    interface Candidate {
      name: string;
      storedAtMs: number;
      expiresAtMs: number;
    }
    const candidates: Candidate[] = [];
    const now = clock.nowMs();
    for (const name of names) {
      try {
        const parsed = JSON.parse(
          readFileSync(join(directory, name), "utf8"),
        ) as Partial<StoredEntry>;
        if (
          typeof parsed.storedAtMs !== "number" ||
          typeof parsed.expiresAtMs !== "number"
        ) {
          rmSync(join(directory, name), { force: true });
          continue;
        }
        if (parsed.expiresAtMs <= now) {
          rmSync(join(directory, name), { force: true });
          continue;
        }
        candidates.push({
          name,
          storedAtMs: parsed.storedAtMs,
          expiresAtMs: parsed.expiresAtMs,
        });
      } catch {
        rmSync(join(directory, name), { force: true });
      }
    }
    candidates.sort((a, b) => a.storedAtMs - b.storedAtMs);
    while (candidates.length >= maxEntries) {
      const oldest = candidates.shift();
      if (oldest === undefined) break;
      rmSync(join(directory, oldest.name), { force: true });
    }
  }

  return {
    get(identityHash: string): unknown | null {
      if (!/^[0-9a-f]{64}$/.test(identityHash)) return null;
      const entry = readEntry(identityHash);
      return entry === null ? null : entry.response;
    },
    put(identityHash: string, response: unknown): void {
      if (!/^[0-9a-f]{64}$/.test(identityHash)) {
        throw new Error("A cache identity must be a lowercase sha256 hex digest.");
      }
      ownerOnlyDir(directory);
      evict();
      const now = clock.nowMs();
      const entry: StoredEntry = {
        schemaVersion: CACHE_ENTRY_SCHEMA_VERSION,
        identityHash,
        storedAtMs: now,
        expiresAtMs: now + ttlMs,
        response,
      };
      const tempPath = join(
        directory,
        `.entry-${identityHash}-${process.pid}-${Math.floor(Math.random() * 2 ** 31)}.tmp`,
      );
      // Owner-only permissions on the payload file (POSIX); on Windows the
      // mode flags are advisory but the directory remains user-profile-local.
      writeFileSync(tempPath, `${JSON.stringify(entry, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      // Atomic replace; on POSIX the rename preserves the 0o600 mode.
      renameSync(tempPath, pathFor(identityHash));
    },
  };
}
