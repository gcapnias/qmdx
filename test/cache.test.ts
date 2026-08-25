import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { manualClock } from "../src/core/clock.js";
import {
  CACHE_ENTRY_SCHEMA_VERSION,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_SECONDS,
  createFileResponseStore,
  parseCachePolicy,
} from "../src/core/cache.js";
import { QmdxError } from "../src/core/errors.js";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const POSIX = process.platform !== "win32";

describe("cache policy parsing", () => {
  it("is disabled by default with conservative bounds when no policy exists", () => {
    const policy = parseCachePolicy(undefined, 'profile "x"');
    expect(policy.expansion.enabled).toBe(false);
    expect(policy.reranking.enabled).toBe(false);
    expect(policy.expansion.maxEntries).toBe(DEFAULT_CACHE_MAX_ENTRIES);
    expect(policy.expansion.ttlSeconds).toBe(DEFAULT_CACHE_TTL_SECONDS);
    // Independent per-stage configuration.
    expect(policy.expansion).not.toBe(policy.reranking);
  });

  it("parses independently configurable enabled stages with bounds and TTLs", () => {
    const policy = parseCachePolicy(
      {
        cache: {
          expansion: { enabled: true, maxEntries: 16, ttlSeconds: 3600 },
          reranking: { enabled: true },
        },
      },
      'profile "x"',
    );
    expect(policy.expansion).toEqual({
      enabled: true,
      maxEntries: 16,
      ttlSeconds: 3600,
    });
    expect(policy.reranking.enabled).toBe(true);
    expect(policy.reranking.maxEntries).toBe(DEFAULT_CACHE_MAX_ENTRIES);
  });

  it("rejects unknown fields, bad bounds, and credential-shaped keys as invalid profile configuration", () => {
    const cases: unknown[] = [
      { cache: { expansion: { enabled: true, wat: 1 } } },
      { cache: { expansion: { enabled: true, maxEntries: 0 } } },
      { cache: { expansion: { enabled: true, ttlSeconds: -5 } } },
      { cache: { expansion: { apiKey: "literal-credential" } } },
      { cache: { reranking: "yes" } },
      { cache: { somestage: {} } },
      { cache: 4 },
    ];
    for (const policySection of cases) {
      let error: unknown;
      try {
        parseCachePolicy(policySection, 'profile "x"');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(QmdxError);
      expect((error as QmdxError).category).toBe("configuration");
      expect((error as QmdxError).code).toBe("invalid_profile");
    }
  });
});

describe("file response store", () => {
  function storeDir(): string {
    return join(mkdtempSync(join(tmpdir(), "qmdx-cache-")), "cache");
  }

  it("round-trips a stored response by identity hash", () => {
    const clock = manualClock(1_000_000);
    const store = createFileResponseStore({
      directory: storeDir(),
      maxEntries: 8,
      ttlMs: 60_000,
      clock,
    });
    const key = sha("identity");
    expect(store.get(key)).toBeNull();
    store.put(key, { outcome: "expanded", queries: [{ type: "lex" }] });
    expect(store.get(key)).toEqual({
      outcome: "expanded",
      queries: [{ type: "lex" }],
    });
  });

  it("treats expired entries as misses and removes them on eviction passes", () => {
    const clock = manualClock(1_000_000);
    const dir = storeDir();
    const store = createFileResponseStore({
      directory: dir,
      maxEntries: 8,
      ttlMs: 60_000,
      clock,
    });
    const key = sha("expiring");
    store.put(key, { value: 1 });
    expect(store.get(key)).toEqual({ value: 1 });
    clock.advance(60_001);
    expect(store.get(key)).toBeNull();
    store.put(sha("fresh"), { value: 2 });
    expect(existsSync(join(dir, `${key}.json`))).toBe(false);
  });

  it("evicts least-recently-stored entries beyond the entry bound", () => {
    const clock = manualClock(1_000_000);
    const dir = storeDir();
    const store = createFileResponseStore({
      directory: dir,
      maxEntries: 3,
      ttlMs: 600_000,
      clock,
    });
    const keys = ["a", "b", "c", "d"].map((name) => {
      clock.advance(10);
      const key = sha(name);
      store.put(key, { name });
      return key;
    });
    expect(existsSync(join(dir, `${keys[0]}.json`))).toBe(false);
    for (const key of keys.slice(1)) {
      expect(store.get(key)).not.toBeNull();
    }
  });

  it("treats corrupt or foreign byte content as a miss, never a crash", () => {
    const dir = storeDir();
    const store = createFileResponseStore({
      directory: dir,
      maxEntries: 4,
      ttlMs: 60_000,
      clock: manualClock(),
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sha("broken")}.json`), "{ not json");
    writeFileSync(
      join(dir, `${sha("wrongversion")}.json`),
      JSON.stringify({
        schemaVersion: 999,
        identityHash: sha("wrongversion"),
        storedAtMs: 0,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        response: { x: 1 },
      }),
    );
    writeFileSync(join(dir, "not-a-hash.txt"), "ignored");
    expect(store.get(sha("broken"))).toBeNull();
    expect(store.get(sha("wrongversion"))).toBeNull();
    expect(store.get("zzzz")).toBeNull();
  });

  it("persists entries with owner-only permissions", () => {
    const clock = manualClock(1_000_000);
    const dir = storeDir();
    const store = createFileResponseStore({
      directory: dir,
      maxEntries: 4,
      ttlMs: 60_000,
      clock,
    });
    store.put(sha("perm"), { ok: true });
    if (POSIX) {
      const dirMode = statSync(dir).mode & 0o777;
      expect(dirMode).toBe(0o700);
      const fileMode =
        statSync(join(dir, `${sha("perm")}.json`)).mode & 0o777;
      expect(fileMode).toBe(0o600);
    }
    // The written entry is exactly the bounded schema; nothing else lingers.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(
      readFileSync(join(dir, files[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(CACHE_ENTRY_SCHEMA_VERSION);
    expect(parsed.identityHash).toBe(sha("perm"));
    expect(typeof parsed.expiresAtMs).toBe("number");
    expect(parsed.response).toEqual({ ok: true });
  });

  it("rejects identity values that are not sha256 hex digests", () => {
    const store = createFileResponseStore({
      directory: storeDir(),
      maxEntries: 2,
      ttlMs: 60_000,
      clock: manualClock(),
    });
    expect(() => store.put("open text identity", { x: 1 })).toThrow();
    expect(store.get("open text identity")).toBeNull();
  });

  it("leaves no temp files behind after writes", () => {
    const dir = storeDir();
    const store = createFileResponseStore({
      directory: dir,
      maxEntries: 2,
      ttlMs: 60_000,
      clock: manualClock(),
    });
    store.put(sha("one"), 1);
    store.put(sha("two"), 2);
    store.put(sha("three"), 3);
    const leftovers = readdirSync(dir).filter((name) =>
      name.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
