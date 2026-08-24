import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RemoteStage } from "../config/resolve.js";
import { userConfigDir } from "../config/location.js";
import type { StageCapabilityEvidence } from "./capability.js";

export const STATE_FILE_NAME = "state.json";

export interface StoredApproval {
  /** Profile fingerprint the approval was granted for. */
  fingerprint: string;
  approvedAtMs: number;
}

export interface StoredLiveCheck {
  /** Profile fingerprint at check time; mismatch means invalidated. */
  fingerprint: string;
  checkedAtMs: number;
  evidence: StageCapabilityEvidence;
}

export interface StoredProfilePreflight {
  approval?: StoredApproval;
  liveChecks?: Partial<Record<RemoteStage, StoredLiveCheck>>;
}

export interface PreflightStateFile {
  schemaVersion: 1;
  profiles: Record<string, StoredProfilePreflight>;
}

export function emptyPreflightState(): PreflightStateFile {
  return { schemaVersion: 1, profiles: {} };
}

export interface PreflightStateOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the state file path (test seam). */
  filePath?: string;
}

export function preflightStateFilePath(
  options: PreflightStateOptions = {},
): string {
  return join(userConfigDir(options.env), STATE_FILE_NAME);
}

/**
 * Loads the local preflight state. A missing, unreadable, or malformed state
 * file yields an empty state: every profile then lacks approval and live
 * checks, so preflight fails closed rather than trusting stale bytes.
 */
export function loadPreflightState(
  options: PreflightStateOptions = {},
): PreflightStateFile {
  const filePath = options.filePath ?? preflightStateFilePath(options);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return emptyPreflightState();
  }
  try {
    const parsed = JSON.parse(raw) as PreflightStateFile;
    if (parsed.schemaVersion !== 1 || typeof parsed.profiles !== "object" || parsed.profiles === null) {
      return emptyPreflightState();
    }
    return parsed;
  } catch {
    return emptyPreflightState();
  }
}

/** Persists preflight state with an atomic temp-file-plus-rename write. */
export function savePreflightState(
  state: PreflightStateFile,
  options: PreflightStateOptions = {},
): string {
  const filePath = options.filePath ?? preflightStateFilePath(options);
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.state-${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
  return filePath;
}
