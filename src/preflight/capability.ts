import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { invalidProfileError, preflightRequiredError } from "../core/errors.js";
import type { EffectiveRoute, RemoteStage } from "../config/resolve.js";

/**
 * Minimal authenticated capability-check seam for remote routes.
 *
 * This module only answers "can this credential reach this endpoint, and does
 * the provider currently list the configured model with the capabilities the
 * route requires?" It deliberately does NOT implement any inference
 * transport; expansion and reranking request/response handling live in their
 * own adapters (tickets #10/#11).
 */

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<HttpResponseLike>;

/**
 * One-off HTTP(S) GET returning the parsed JSON body. Uses `agent: false`
 * so no keep-alive socket outlives the request: the CLI must be able to
 * exit immediately after recording preflight results.
 */
export const defaultFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (cause) {
      reject(cause);
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      reject(new Error(`Unsupported endpoint protocol ${target.protocol}`));
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = {
      method: "GET",
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: init?.headers,
      agent: false,
    };
    const req = send(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
          status: res.statusCode ?? 0,
          json: async () => JSON.parse(raw),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });

export interface StageCapabilityEvidence {
  stage: RemoteStage;
  providerKind: "openai-compatible" | "cohere";
  /** URL of the authenticated catalog request that was made. */
  modelsUrl: string;
  modelListed: boolean;
  /** Expansion routes must support strict JSON Schema structured output. */
  strictSchemaRequired: boolean | null;
  /** Cohere-declared service endpoints for the model, when published. */
  declaredEndpoints: string[] | null;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function bearerHeaders(credential: string): Record<string, string> {
  return { Authorization: `Bearer ${credential}` };
}

function authFailure(stage: RemoteStage, status: number): Error {
  return preflightRequiredError(
    `Live capability check for the ${stage} route failed authentication ` +
      `(HTTP ${status}). Check the credential named by the route's ` +
      "credentialEnv and run `qmdx setup` again.",
  );
}

function unreachable(stage: RemoteStage, detail: string): Error {
  return preflightRequiredError(
    `Live capability check for the ${stage} route could not be completed: ${detail}. ` +
      "Run `qmdx setup` again once the endpoint is reachable.",
  );
}

/**
 * Checks an OpenAI-compatible catalog: GET {endpoint}/models authenticated
 * with the route credential. The configured model id must appear in the
 * returned catalog. Expansion routes additionally require strict JSON Schema
 * behavior; that property is recorded as required evidence here and proven
 * per-request by the expansion adapter itself.
 */
export async function checkOpenAiCompatibleCapabilities(
  route: EffectiveRoute,
  credential: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<StageCapabilityEvidence> {
  const modelsUrl = joinUrl(route.endpoint, "models");
  let response: HttpResponseLike;
  try {
    response = await fetchImpl(modelsUrl, { headers: bearerHeaders(credential) });
  } catch (cause) {
    throw unreachable(
      route.stage,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw authFailure(route.stage, response.status);
  }
  if (!response.ok) {
    throw unreachable(route.stage, `HTTP ${response.status} from ${modelsUrl}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw unreachable(
      route.stage,
      `the models catalog at ${modelsUrl} is not valid JSON`,
    );
  }
  const data = (body as { data?: unknown } | null)?.data;
  const modelListed =
    Array.isArray(data) &&
    data.some((entry) => (entry as { id?: unknown })?.id === route.model);
  if (!modelListed) {
    throw invalidProfileError(
      `The ${route.stage} route is not usable: provider "${route.provider}" does not list model "${route.model}" in its current catalog at ${modelsUrl}.`,
    );
  }
  return {
    stage: route.stage,
    providerKind: "openai-compatible",
    modelsUrl,
    modelListed,
    strictSchemaRequired: route.stage === "expansion" ? true : null,
    declaredEndpoints: null,
  };
}

/**
 * Checks the Cohere catalog: GET {endpoint}/v1/models authenticated with the
 * route credential. The configured model must be listed and, when the catalog
 * publishes per-model endpoints, must include the rerank endpoint.
 */
export async function checkCohereCapabilities(
  route: EffectiveRoute,
  credential: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<StageCapabilityEvidence> {
  const modelsUrl = `${joinUrl(route.endpoint, "v1/models")}?page_size=1000`;
  let response: HttpResponseLike;
  try {
    response = await fetchImpl(modelsUrl, { headers: bearerHeaders(credential) });
  } catch (cause) {
    throw unreachable(
      route.stage,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw authFailure(route.stage, response.status);
  }
  if (!response.ok) {
    throw unreachable(route.stage, `HTTP ${response.status} from ${modelsUrl}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw unreachable(
      route.stage,
      `the models catalog at ${modelsUrl} is not valid JSON`,
    );
  }
  const models = (body as { models?: unknown } | null)?.models;
  const entry = Array.isArray(models)
    ? models.find((model) => (model as { name?: unknown })?.name === route.model)
    : undefined;
  if (entry === undefined) {
    throw invalidProfileError(
      `The ${route.stage} route is not usable: provider "${route.provider}" does not list model "${route.model}" in its current catalog at ${modelsUrl}.`,
    );
  }
  const rawEndpoints = (entry as { endpoints?: unknown }).endpoints;
  const declaredEndpoints = Array.isArray(rawEndpoints)
    ? rawEndpoints.filter((value): value is string => typeof value === "string")
    : null;
  if (declaredEndpoints !== null && !declaredEndpoints.includes("rerank")) {
    throw invalidProfileError(
      `The ${route.stage} route is not usable: provider "${route.provider}" does not declare a rerank endpoint for model "${route.model}".`,
    );
  }
  return {
    stage: route.stage,
    providerKind: "cohere",
    modelsUrl,
    modelListed: true,
    strictSchemaRequired: null,
    declaredEndpoints,
  };
}

/** Dispatches to the provider-specific minimal capability checker. */
export function checkRouteCapabilities(
  route: EffectiveRoute,
  credential: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<StageCapabilityEvidence> {
  return route.provider === "cohere"
    ? checkCohereCapabilities(route, credential, fetchImpl)
    : checkOpenAiCompatibleCapabilities(route, credential, fetchImpl);
}
