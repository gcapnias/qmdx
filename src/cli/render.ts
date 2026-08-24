import type {
  ErrorEnvelope,
  ResultEnvelope,
  SearchResultItem,
} from "../core/envelope.js";

export interface IoStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text);
}

export function renderResultEnvelope(
  io: IoStreams,
  envelope: ResultEnvelope,
): void {
  write(io.stdout, `${JSON.stringify(envelope, null, 2)}\n`);
}

export function renderErrorEnvelope(
  io: IoStreams,
  envelope: ErrorEnvelope,
): void {
  write(io.stderr, `${JSON.stringify(envelope, null, 2)}\n`);
}

export function renderHumanResults(
  io: IoStreams,
  envelope: ResultEnvelope,
): void {
  for (const warning of envelope.warnings) {
    write(io.stderr, `Warning: ${warning.message}\n`);
  }
  if (envelope.results.length === 0) {
    write(io.stdout, "No results found.\n");
    return;
  }
  for (const result of envelope.results) {
    renderResultLine(io, result);
  }
}

function renderResultLine(
  io: IoStreams,
  result: SearchResultItem,
): void {
  const title = result.title || "(untitled)";
  write(io.stdout, `${result.rank}. ${title}  ${result.score}\n`);
  const lineSuffix =
    result.line === null || result.line === undefined
      ? ""
      : `:${result.line}`;
  write(
    io.stdout,
    `  ${result.file}${lineSuffix}  ${result.docid}\n`,
  );
  if (result.snippet) {
    write(io.stdout, `  ${result.snippet}\n`);
  }
}
