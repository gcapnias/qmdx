#!/usr/bin/env node
import { runQueryCommand } from "../cli/query-command.js";
import { runProfileCheckCommand } from "../cli/profile-command.js";
import { invalidInvocationError, QmdxError } from "../core/errors.js";
import { exitCodeForCategory } from "../core/exit-codes.js";

const USAGE = `Usage:
  qmdx query <query> [options]
  qmdx setup [--profile <name>]
  qmdx doctor [--profile <name>]

Query options:
  -n, --limit <n>        Final result count (1-80, default 10)
  --min-score <n>        Minimum public score in [0,1]
  --full                 Include complete result body
  -c, --collection <name>  Restrict to a collection (repeatable)
  --intent <text>        Search intent guiding chunk selection and reranking
  --format <kind>        "human" (default) or "json"
  --full-path            Show on-disk paths instead of qmd:// URIs
  --line-numbers         Show line numbers
  --explain              Add per-result retrieval and reranking provenance
  --profile <name>       Select a configured route profile
  --require-remote       Fail unless both remote stages succeed
  --no-expand            Diagnostic mode using only original routes
  --no-rerank            Diagnostic mode returning QMD fused order

Route profiles are read from the version-1 configuration file in the OS user
configuration directory; credentials are only ever named via environment
variables ("credentialEnv"), never stored or passed literally.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const error = invalidInvocationError("a command is required");
    process.stderr.write(`qmdx: ${error.message}\n\n${USAGE}`);
    return exitCodeForCategory(error.category);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = argv[0]!;
  if (command === "query") {
    return runQueryCommand(argv.slice(1));
  }
  if (command === "setup" || command === "doctor") {
    return runProfileCheckCommand(command, argv.slice(1));
  }
  const error = invalidInvocationError(`unknown command "${command}"`);
  process.stderr.write(`qmdx: ${error.message}\n\n${USAGE}`);
  return exitCodeForCategory(error.category);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof QmdxError ? error.message : String(error);
    process.stderr.write(`qmdx: ${message}\n`);
    process.exitCode = 5;
  });
