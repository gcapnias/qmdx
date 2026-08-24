import {
  invalidInvocationError,
  QmdxError,
} from "../core/errors.js";
import {
  resolveSelectedProfile,
  routeDiagnostic,
} from "../config/resolve.js";
import { emitHumanFailure } from "./failure.js";

export interface CommandIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const SUPPORTED_FLAGS: ReadonlySet<string> = new Set(["--profile"]);

const COMMAND_SUMMARY: Record<"setup" | "doctor", string> = {
  setup: "Route profile resolved. Privacy approval and live route checks are not implemented yet.",
  doctor: "Route profile resolved. Local-index and live diagnostics are not implemented yet.",
};

/**
 * Minimal setup/doctor entry points for ticket #7: they accept `--profile`,
 * resolve the selection through the version-1 profile configuration system
 * (surfacing invalid_profile / missing_credentials as exit-2 failures), and
 * print a non-secret summary. Stage-specific checks arrive with ticket #8.
 */
export async function runProfileCheckCommand(
  command: "setup" | "doctor",
  argv: readonly string[],
  io: CommandIo = process,
): Promise<number> {
  const streams = { stdout: io.stdout, stderr: io.stderr };
  try {
    let profile: string | null = null;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (!SUPPORTED_FLAGS.has(arg)) {
        throw new QmdxError(
          "invocation",
          "unsupported_option",
          `Unsupported option "${arg}" for "${command}". Only --profile is supported.`,
        );
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw invalidInvocationError(`Option ${arg} requires a value.`);
      }
      profile = value;
      i++;
    }

    const effective = resolveSelectedProfile(profile);
    if (effective === null) {
      throw invalidInvocationError(
        `no profile selected; configure defaultProfile or pass --profile <name> to "${command}"`,
      );
    }

    for (const stage of ["expansion", "reranking"] as const) {
      const route = routeDiagnostic(effective[stage]);
      streams.stdout.write(
        `${command} ${stage}: provider=${route.provider} endpoint=${route.endpoint} model=${route.model} credentialEnv=${route.credentialEnv}\n`,
      );
    }
    streams.stdout.write(`${COMMAND_SUMMARY[command]}\n`);
    return 0;
  } catch (error) {
    return emitHumanFailure(error, streams);
  }
}
