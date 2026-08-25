export const MINIMUM_SUPPORTED_MAJOR = 22;
export const TESTED_MAJORS: readonly number[] = [22, 24];

export interface RuntimeAssessment {
  /** Parsed Node.js major version, or null when the version is unparseable. */
  major: number | null;
  /**
   * false for majors below the minimum and for odd-numbered (non-LTS)
   * majors: QMDX must refuse to run. true otherwise.
   */
  supported: boolean;
  /** true when supported but not one of the initially tested LTS majors. */
  untestedEvenLts: boolean;
}

/**
 * Classifies the current Node.js runtime against the QMDX v1 support policy:
 * minimum Node 22, odd-numbered/non-LTS majors rejected, tested majors are
 * the initially qualified LTS releases, and newer even LTS majors run with a
 * warning instead of a hard failure.
 */
export function assessNodeRuntime(
  version: string = process.versions.node,
): RuntimeAssessment {
  const rawMajor = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(rawMajor)) {
    return { major: null, supported: false, untestedEvenLts: false };
  }
  const belowMinimum = rawMajor < MINIMUM_SUPPORTED_MAJOR;
  const nonLts = rawMajor % 2 !== 0;
  const supported = !belowMinimum && !nonLts;
  return {
    major: rawMajor,
    supported,
    untestedEvenLts: supported && !TESTED_MAJORS.includes(rawMajor),
  };
}

export function unsupportedRuntimeMessage(assessment: RuntimeAssessment): string {
  const display = assessment.major === null ? "unknown" : `v${assessment.major}`;
  return (
    `qmdx: Node.js ${display} is not a supported runtime. QMDX requires an ` +
    `even-numbered LTS Node.js major ${MINIMUM_SUPPORTED_MAJOR} or later; ` +
    `odd-numbered and other non-LTS majors are rejected. ` +
    `Tested majors: ${TESTED_MAJORS.join(" and ")}.`
  );
}

export function untestedRuntimeWarning(assessment: RuntimeAssessment): string {
  return (
    `qmdx: Warning: Node.js v${assessment.major} is not yet a tested QMDX ` +
    `runtime (tested majors: ${TESTED_MAJORS.join(" and ")}). Continuing; ` +
    `please report any issues you encounter.`
  );
}
