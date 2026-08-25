import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_SUPPORTED_MAJOR,
  TESTED_MAJORS,
  assessNodeRuntime,
} from "../src/runtime/node-support.js";
import { BIN_PATH } from "./helpers/test-index.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function runBinWithNodeVersion(
  nodeVersion: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const preload = [
    `Object.defineProperty(process.versions, "node", {`,
    `  value: ${JSON.stringify(nodeVersion)},`,
    `  configurable: true,`,
    `});`,
    `import(${JSON.stringify(pathToFileURL(BIN_PATH).href)});`,
  ].join("");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", preload, BIN_PATH, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("assessNodeRuntime support policy", () => {
  it("accepts the tested LTS majors", () => {
    for (const version of ["22.11.0", "24.19.0"]) {
      const assessment = assessNodeRuntime(version);
      expect(assessment.supported, version).toBe(true);
      expect(assessment.untestedEvenLts, version).toBe(false);
    }
    expect(TESTED_MAJORS).toContain(MINIMUM_SUPPORTED_MAJOR);
  });

  it("rejects majors below the minimum", () => {
    for (const version of ["18.0.0", "20.11.1", "21.7.3"]) {
      expect(assessNodeRuntime(version).supported, version).toBe(false);
    }
  });

  it("rejects odd-numbered non-LTS majors above the minimum too", () => {
    for (const version of ["23.11.0", "25.4.0"]) {
      const assessment = assessNodeRuntime(version);
      expect(assessment.supported, version).toBe(false);
      expect(assessment.untestedEvenLts, version).toBe(false);
    }
  });

  it("warns without rejecting untested newer even LTS majors", () => {
    for (const version of ["26.1.0", "28.0.0"]) {
      const assessment = assessNodeRuntime(version);
      expect(assessment.supported, version).toBe(true);
      expect(assessment.untestedEvenLts, version).toBe(true);
    }
  });

  it("treats an unparseable runtime as unsupported", () => {
    expect(assessNodeRuntime("").supported).toBe(false);
  });
});

describe("bin runtime gate", () => {
  it(
    "refuses to run on odd/non-LTS and below-minimum majors with exit code 2",
    async () => {
      for (const version of ["21.7.3", "23.11.0", "25.4.0"]) {
        const run = await runBinWithNodeVersion(version, ["--help"]);
        expect(run.status, version).toBe(2);
        expect(run.stdout, version).toBe("");
        expect(run.stderr, version).toMatch(/not a supported runtime/);
        expect(run.stderr, version).toMatch(/even-numbered LTS/);
      }
    },
  );

  it("suppresses the untested-major warning in --format json mode", async () => {
    const jsonMode = await runBinWithNodeVersion("26.1.0", [
      "--format",
      "json",
    ]);
    expect(jsonMode.status).toBe(2);
    expect(jsonMode.stderr).not.toMatch(/tested QMDX runtime/);

    const humanMode = await runBinWithNodeVersion("26.1.0", ["bogus-command"]);
    expect(humanMode.stderr).toMatch(/not yet a tested QMDX runtime/);
  });

  it("runs silently on tested majors", async () => {
    const run = await runBinWithNodeVersion(
      `${TESTED_MAJORS[TESTED_MAJORS.length - 1]}.99.0`,
      ["query", "--help"],
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Usage: qmdx");
  });
});

describe("packaging contract guard", () => {
  it("check-package script passes against the committed tree", () => {
    const output = execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "check-package.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("packaging contract satisfied");
  });

  it("package.json promises no stable library API and keeps the CLI surface", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(pkg.exports).toBeUndefined();
    expect(pkg.type).toBe("module");
    expect(pkg.bin.qmdx).toBe("./dist/bin/qmdx.js");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.dependencies["@tobilu/qmd"]).toBe("2.8.3");

    const policy = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "sdk-policy.json"), "utf8"),
    );
    expect(policy.upgradePolicy.minQmdxReleaseOnUpgrade).toBe("minor");
    expect(policy.upgradePolicy.releaseTypeOnBreakingChange).toBe("major");
    expect(
      policy.upgradePolicy.requiresRepresentativeIndexCompatibilityTests,
    ).toBe(true);
  });
});
