#!/usr/bin/env node
// Guards the QMDX v1 packaging contract:
// - spec-required package metadata (name, bin, engines, native ESM, files)
// - exact-pinned direct dependencies and a reproducible npm ci lockfile
// - the @tobilu/qmd SDK pin against scripts/sdk-policy.json
// - no stable library API surface promised (no "exports" field)
// - required install-script allowances for the native dependency chain
// - README statements for platform support and the no-library-API policy
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) =>
  JSON.parse(readFileSync(join(root, relative), "utf8"));

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
}

const pkg = read("package.json");
const lockfile = read("package-lock.json");
const policy = read("scripts/sdk-policy.json");
const readme = readFileSync(join(root, "README.md"), "utf8");

check(pkg.name === "@gcapnias/qmdx", 'package name must be "@gcapnias/qmdx"');
check(
  pkg.bin?.qmdx === "./dist/bin/qmdx.js",
  'bin.qmdx must map to "./dist/bin/qmdx.js"',
);
check(pkg.type === "module", "package must be native ESM (type: module)");
check(
  pkg.engines?.node === ">=22",
  'engines.node must be ">=22" (minimum runtime Node.js 22)',
);
check(
  Array.isArray(pkg.files) && pkg.files.includes("dist"),
  'files must include "dist"',
);

check(
  pkg.exports === undefined,
  "no \"exports\" field may be published: QMDX promises no stable JavaScript/TypeScript library API",
);

const isExact = (range) => typeof range === "string" && range.length > 0 && !/[\^~><=*x|]/.test(range);
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  check(isExact(range), `dependency ${name}@${range} must be an exact pinned version`);
}

const sdkPin = policy.pinnedVersion;
check(
  pkg.dependencies?.[policy.sdk] === sdkPin,
  `${policy.sdk} must be the exact direct dependency ${sdkPin} per scripts/sdk-policy.json`,
);

const lockRoot = lockfile.packages?.[""] ?? {};
check(
  JSON.stringify(lockRoot.dependencies ?? {}) === JSON.stringify(pkg.dependencies ?? {}),
  "package-lock.json root dependencies are out of sync with package.json",
);
check(
  lockRoot.devDependencies !== undefined ||
    Object.keys(pkg.devDependencies ?? {}).length === 0,
  "package-lock.json root devDependencies are missing",
);
check(
  lockfile.packages?.[`node_modules/${policy.sdk}`]?.version === sdkPin,
  `package-lock.json must resolve ${policy.sdk} to exactly ${sdkPin}`,
);

for (const entry of ["better-sqlite3@13.0.3", "esbuild@0.28.2", "node-llama-cpp@3.20.0"]) {
  check(
    pkg.allowScripts?.[entry] === true,
    `allowScripts must keep "${entry}": true so npm ci can prepare native dependencies`,
  );
}

for (const phrase of [
  "Windows 11 x64",
  "experimental",
  "no stable JavaScript or TypeScript library API",
]) {
  check(
    readme.includes(phrase),
    `README.md must state "${phrase}"`,
  );
}

if (failures.length > 0) {
  process.stderr.write("check-package failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}
process.stdout.write("check-package: packaging contract satisfied.\n");
