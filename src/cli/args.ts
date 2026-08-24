import {
  invalidInvocationError,
  unsupportedOptionError,
} from "../core/errors.js";
import type { QueryRequest } from "../pipeline/search.js";

export const SUPPORTED_FLAGS = [
  "-n",
  "--limit",
  "--min-score",
  "--full",
  "-c",
  "--collection",
  "--intent",
  "--format",
  "--full-path",
  "--line-numbers",
  "--explain",
  "--profile",
  "--require-remote",
  "--no-expand",
  "--no-rerank",
] as const;

export interface ParsedQueryInvocation extends QueryRequest {
  format: "human" | "json";
  fullPath: boolean;
  lineNumbers: boolean;
  profile: string | null;
  requireRemote: boolean;
}

const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-n",
  "--limit",
  "--min-score",
  "-c",
  "--collection",
  "--intent",
  "--format",
  "--profile",
]);

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--full",
  "--full-path",
  "--line-numbers",
  "--explain",
  "--require-remote",
  "--no-expand",
  "--no-rerank",
]);

export function parseQueryArgs(argv: readonly string[]): ParsedQueryInvocation {
  const positional: string[] = [];
  const collections: string[] = [];
  let limit = 10;
  let minScore: number | null = null;
  let intent: string | null = null;
  let format: "human" | "json" = "human";
  let profile: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(arg) && !BOOLEAN_FLAGS.has(arg)) {
      throw unsupportedOptionError(arg);
    }

    if (BOOLEAN_FLAGS.has(arg)) continue;

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      throw invalidInvocationError(`Option ${arg} requires a value.`);
    }
    i++;

    switch (arg) {
      case "-n":
      case "--limit":
        limit = parseLimit(value);
        break;
      case "--min-score":
        minScore = parseMinScore(value);
        break;
      case "-c":
      case "--collection":
        collections.push(value);
        break;
      case "--intent":
        intent = value;
        break;
      case "--format":
        format = parseFormat(value);
        break;
      case "--profile":
        profile = value;
        break;
    }
  }

  return {
    originalQuery: extractQuery(positional),
    intent,
    collections,
    limit,
    minScore,
    full: argv.includes("--full"),
    explain: argv.includes("--explain"),
    noExpand: argv.includes("--no-expand"),
    noRerank: argv.includes("--no-rerank"),
    fullPath: argv.includes("--full-path"),
    lineNumbers: argv.includes("--line-numbers"),
    requireRemote: argv.includes("--require-remote"),
    format,
    profile,
  };
}

function extractQuery(positional: readonly string[]): string {
  if (positional.length === 0) {
    throw invalidInvocationError("query text is required");
  }
  if (positional.length > 1) {
    throw invalidInvocationError(
      `unexpected argument "${positional[1]}"; quote the full query as one argument`,
    );
  }
  const query = positional[0]!;
  if (query.trim() === "") {
    throw invalidInvocationError("query text is required");
  }
  if ([...query].length > 2048) {
    throw invalidInvocationError(
      "query text exceeds the maximum of 2048 Unicode characters",
    );
  }
  return query;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 80) {
    throw invalidInvocationError(
      "--limit expects an integer from 1 through 80",
    );
  }
  return parsed;
}

function parseMinScore(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw invalidInvocationError(
      "--min-score expects a number in [0,1]",
    );
  }
  return parsed;
}

function parseFormat(value: string): "human" | "json" {
  if (value !== "human" && value !== "json") {
    throw invalidInvocationError(
      '--format expects "human" or "json"',
    );
  }
  return value;
}
