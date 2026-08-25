import type {
  ErrorEnvelope,
  ResultEnvelope,
  SearchResultItem,
} from "../core/envelope.js";

export interface IoStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface HumanPresentation {
  fullPath: boolean;
  lineNumbers: boolean;
  /** Display path per result, aligned with envelope.results indexes. */
  paths: readonly string[];
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
  presentation: HumanPresentation = {
    fullPath: false,
    lineNumbers: false,
    paths: [],
  },
): void {
  for (const warning of envelope.warnings) {
    write(io.stderr, `Warning: ${warning.message}\n`);
  }
  if (envelope.results.length === 0) {
    write(io.stdout, "No results found.\n");
    return;
  }
  for (const [index, result] of envelope.results.entries()) {
    renderResultLine(io, result, presentation, presentation.paths[index]);
  }
}

function renderResultLine(
  io: IoStreams,
  result: SearchResultItem,
  presentation: HumanPresentation,
  displayPath: string | undefined,
): void {
  const title = result.title || "(untitled)";
  write(io.stdout, `${result.rank}. ${title}  ${result.score}\n`);
  const ident =
    presentation.fullPath && displayPath ? displayPath : result.file;
  const lineSuffix =
    result.line === null || result.line === undefined
      ? ""
      : `:${result.line}`;
  write(io.stdout, `  ${ident}${lineSuffix}  ${result.docid}\n`);
  if (presentation.fullPath && !displayPath) {
    write(io.stderr, `Warning: could not resolve a full path for ${result.file}\n`);
  }

  if (result.body !== undefined) {
    const startLine = presentation.lineNumbers ? 1 : null;
    writeContent(io, result.body, startLine);
    return;
  }
  if (result.snippet) {
    const startLine = presentation.lineNumbers
      ? (result.line ?? -1) + 1
      : null;
    writeContent(io, result.snippet, startLine);
  }
}

function writeContent(
  io: IoStreams,
  content: string,
  startLine: number | null,
): void {
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    const prefix = startLine === null ? "  " : `  ${startLine + index}: `;
    write(io.stdout, `${prefix}${line}\n`);
  });
}
