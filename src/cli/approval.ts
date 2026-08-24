import { createInterface } from "node:readline/promises";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { privacyApprovalRequiredError } from "../core/errors.js";
import { recordProfileApproval } from "../preflight/preflight.js";
import type { PrivacyDeclaration } from "../preflight/privacy.js";

/**
 * The exact phrase a user must type to grant privacy approval. Anything else
 * cancels and leaves no approval recorded.
 */
export const APPROVAL_PHRASE = "approve";

/**
 * Automation/test seam: when set, its value is consumed as the interactive
 * approval response instead of reading the controlling terminal. Interactive
 * behavior without this seam still requires a real TTY on stdin.
 */
const APPROVAL_INPUT_ENV = "QMDX_APPROVAL_INPUT";

function renderDeclarationSummary(
  profileName: string,
  declaration: PrivacyDeclaration,
): string[] {
  return [
    `Privacy declaration v${declaration.declarationVersion} for profile "${profileName}":`,
    `  Endpoint / region : ${declaration.endpoint} (${declaration.region})`,
    `  Expansion payload : ${declaration.stagePayloads.expansion}`,
    `  Reranking payload : ${declaration.stagePayloads.reranking}`,
    `  Retention         : ${declaration.retention}`,
    `  Training use      : ${declaration.trainingUse}`,
    `  Reviewed sources  : ${declaration.reviewedSources.join(", ")}`,
    "",
    `Type "${APPROVAL_PHRASE}" to approve first use of this configuration, anything else to cancel.`,
  ];
}

async function readResponse(input?: NodeJS.ReadableStream): Promise<string | null> {
  if (input !== undefined) {
    const rl = createInterface({ input });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  }
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  }
  return null;
}

export interface ApprovalPromptDeps {
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** Overrides the state file path (test seam). */
  statePath?: string;
  /** Overrides the response source (unit-test seam). */
  input?: NodeJS.ReadableStream;
  /** Suppresses writing the prompt text (test seam). */
  quiet?: boolean;
}

/**
 * Shows the versioned privacy declaration and records an explicit approval
 * for the given profile fingerprint. Throws privacy_approval_required when
 * the session cannot interactively confirm approval (non-TTY stdin without
 * the automation seam) or when the user declines.
 */
export async function obtainExplicitApproval(
  requestedProfile: string | null | undefined,
  profileName: string,
  fingerprint: string,
  declaration: PrivacyDeclaration,
  out: NodeJS.WritableStream,
  deps: ApprovalPromptDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const lines = renderDeclarationSummary(profileName, declaration);
  if (!deps.quiet) {
    for (const line of lines) out.write(`${line}\n`);
  }

  let response: string | null;
  const seam = env[APPROVAL_INPUT_ENV];
  if (seam !== undefined) {
    response = seam;
  } else {
    response = await readResponse(deps.input);
  }

  if (response === null || response.trim().toLowerCase() !== APPROVAL_PHRASE) {
    throw privacyApprovalRequiredError(
      response === null
        ? "Privacy approval requires an interactive session; refusing to proceed without explicit approval."
        : "Privacy approval was not granted; nothing was transmitted.",
    );
  }

  recordProfileApproval(requestedProfile, fingerprint, {
    clock: deps.clock ?? systemClock,
    env,
    ...(deps.statePath !== undefined ? { statePath: deps.statePath } : {}),
  });
}
