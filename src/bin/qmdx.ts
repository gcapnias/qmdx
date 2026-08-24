#!/usr/bin/env node
import { runQueryCommand } from "../cli/query-command.js";
import { invalidInvocationError, QmdxError } from "../core/errors.js";
import { exitCodeForCategory } from "../core/exit-codes.js";

const USAGE = `Usage: qmdx query <query> [options]

Options:
  -n, --limit <n>        Final result count (1-80, default 10)
  --min-score <n>        Minimum public score in [0,1]
  --full                 Include complete result body
  -c, --collection <name>  Restrict to a collection (repeatable)
  --intent <text>        Search intent guiding chunk selection and reranking
  --format <kind>        "human" (default) or "json"
  --full-path            Show on-disk paths instead of qmd:// URIs
  --line-numbers         Show line numbers
  --explain              Add per-result retrieval and reranking provenance
  --require-remote       Fail unless both remote stages succeed
  --no-expand            Diagnostic mode using only original routes
  --no-rerank            Diagnostic mode returning QMD fused order
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] !== "query") {
    const error =
      argv.length === 0
        ? invalidInvocationError("a command is required")
        : invalidInvocationError(`unknown command "${argv[0]}"`);
    process.stderr.write(`qmdx: ${error.message}\n\n${USAGE}`);
    return exitCodeForCategory(error.category);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  return runQueryCommand(argv.slice(1));
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
