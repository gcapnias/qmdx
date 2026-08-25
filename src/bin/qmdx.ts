#!/usr/bin/env node
import { runQueryCommand } from "../cli/query-command.js";
import {
  runReadinessCommand,
  type ReadinessCommandName,
} from "../cli/readiness-command.js";
import { invalidInvocationError, QmdxError } from "../core/errors.js";
import {
  assessNodeRuntime,
  unsupportedRuntimeMessage,
  untestedRuntimeWarning,
} from "../runtime/node-support.js";
import { EXIT_CODES, exitCodeForCategory } from "../core/exit-codes.js";

const USAGE = `Usage: qmdx <command> [options]

Commands:
  query <query>   Search a QMD index with remote expansion and reranking
  setup           Validate local index readiness before first use
  doctor          Repeat local index readiness diagnostics

The query is either a plain query or a typed query document whose lines are
"intent:", "lex:", "vec:", or "hyde:" routes (QMD 2.8.3 grammar). A document
without a plain query requires --no-expand.

query options:
  -n, --limit <n>        Final result count (1-80, default 10)
  --min-score <n>        Minimum public score in [0,1]
  --full                 Include complete result body
  -c, --collection <name>  Restrict to a collection (repeatable)
  --intent <text>        Search intent guiding chunk selection and reranking
  --format <kind>        "human" (default) or "json"
  --full-path            Show QMD display paths instead of qmd:// URIs
  --line-numbers         Number snippet and body lines
  --explain              Add per-result retrieval and reranking provenance
  --profile <name>       Select a configured route profile
  --require-remote       Fail unless both remote stages succeed
  --no-expand            Diagnostic mode using only explicit/original routes
  --no-rerank            Diagnostic mode returning QMD fused order

setup/doctor options:
  --profile <name>       Select a configured route profile
  --format <kind>        "human" (default) or "json"

Route profiles are read from the version-1 configuration file in the OS user
configuration directory; credentials are only ever named via environment
variables ("credentialEnv"), never stored or passed literally.
`;

function commandOf(argv: readonly string[]):
  | { kind: "query" }
  | { kind: "readiness"; command: ReadinessCommandName }
  | { kind: "unknown"; name: string }
  | { kind: "none" } {
  if (argv.length === 0) return { kind: "none" };
  const name = argv[0]!;
  if (name === "query") return { kind: "query" };
  if (name === "setup" || name === "doctor") return { kind: "readiness", command: name };
  return { kind: "unknown", name };
}

function requestedJsonFormat(argv: readonly string[]): boolean {
  const index = argv.indexOf("--format");
  if (index !== -1) return argv[index + 1] === "json";
  return argv.some((arg) => arg === "--format=json");
}

const argv = process.argv.slice(2);
const runtime = assessNodeRuntime();
if (!runtime.supported) {
  process.stderr.write(`${unsupportedRuntimeMessage(runtime)}\n`);
  process.exitCode = EXIT_CODES.invalidInvocationOrConfiguration;
} else {
  if (runtime.untestedEvenLts && !requestedJsonFormat(argv)) {
    process.stderr.write(`${untestedRuntimeWarning(runtime)}\n`);
  }
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof QmdxError ? error.message : String(error);
      process.stderr.write(`qmdx: ${message}\n`);
      process.exitCode = EXIT_CODES.unexpectedInternalFailure;
    });
}

async function main(): Promise<number> {
  const command = commandOf(argv);
  if (command.kind === "none" || command.kind === "unknown") {
    const error =
      command.kind === "none"
        ? invalidInvocationError("a command is required")
        : invalidInvocationError(`unknown command "${command.name}"`);
    process.stderr.write(`qmdx: ${error.message}\n\n${USAGE}`);
    return exitCodeForCategory(error.category);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "query") {
    return runQueryCommand(argv.slice(1));
  }
  return runReadinessCommand(command.command, argv.slice(1));
}

