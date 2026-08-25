import type { EnvelopeWarning } from "../core/envelope.js";
import { QmdxError } from "../core/errors.js";

export class RequiredRemoteFailure extends QmdxError {
  constructor(
    message: string,
    stage: "expansion" | "reranking",
    public readonly stageWarnings: EnvelopeWarning[],
  ) {
    super("required_remote", "required_remote_failed", message, stage);
  }
}
