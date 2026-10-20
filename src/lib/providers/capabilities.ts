/**
 * Per-model capabilities for the one provider whose model list Saale builds
 * itself: a self-hosted OpenAI-compatible endpoint.
 *
 * Pi's catalog answers this for every hosted model it knows, but a model that is
 * only ever served by the user's own endpoint has no catalog entry — and a
 * definition built from "id + name" alone still has to claim something. Claiming
 * text-only makes Pi strip every image out of the request (`transformMessages` →
 * `downgradeUnsupportedImages`), so a vision model imported from a local server
 * silently answers about a request that never carried the picture. Claiming
 * image support on a text-only endpoint is just as wrong: the endpoint rejects
 * the request outright.
 *
 * Vision is therefore recorded per model: read from the endpoint where it can be
 * read — `llama-server` reports it in `/props` as `modalities.vision`, the
 * projector it actually loaded — and set by the user where it cannot. What is
 * stored is what the model definition claims, so nothing decides per request
 * whether a picture is worth sending.
 *
 * The same map carries a model's token limits: one local server can serve a 4k
 * model and a 128k one, and Pi needs the right window per model to know when to
 * compact. An absent limit inherits the endpoint's default for that field.
 */

/** What Saale knows about one discovered model. */
export interface ModelCapabilities {
  /** Whether the model accepts image input. Absent = not known. */
  vision?: boolean;
  /** Context window of this model. Absent = inherit the endpoint's default. */
  contextWindow?: number;
  /** Output cap for this model. Absent = inherit the endpoint's default. */
  maxOutputTokens?: number;
}

/** Per-provider map of model id → capabilities. */
export type ModelCapabilityMap = Record<string, ModelCapabilities>;

/** Total wall-clock budget for a capability sweep, however many models it covers. */
export const DETECTION_BUDGET_MS = 5_000;

/** Timeout for a single `/props` probe. */
const PROBE_TIMEOUT_MS = 2_000;

/** Probes in flight at once — a local server serves these trivially, but not 500 at once. */
const PROBE_CONCURRENCY = 6;

/** Models probed at most, so a huge catalog cannot turn a save into a sweep. */
const MAX_PROBED_MODELS = 200;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The server root a llama.cpp instance serves its introspection endpoints from.
 *
 * `/props`, `/slots` and `/health` live at the root, while the OpenAI-compatible
 * API — the URL a user configures as the provider base — is mounted under
 * `/v1`. Probing `${baseUrl}/props` therefore asks for `/v1/props`, which does
 * not exist, and every model comes back with no capabilities at all. Strip the
 * version segment so the probe reaches the real endpoint.
 */
function introspectionBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Read a JSON object from a capability endpoint.
 *
 * A non-OK response is an answer ("no such endpoint"), not a failure — most
 * OpenAI-compatible servers have no `/props` at all — so it is not logged. A
 * transport error is logged: that one is worth knowing about.
 */
async function fetchJsonObject(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch (err) {
    console.error(`Failed to probe model capabilities at ${url}:`, err);
    return null;
  }
}

/** The `vision` flag of a llama.cpp `/props` payload, when it reports one. */
function visionFromProps(props: Record<string, unknown>): boolean | undefined {
  const modalities = props.modalities;
  if (typeof modalities !== "object" || modalities === null) return undefined;
  const vision = (modalities as Record<string, unknown>).vision;
  return typeof vision === "boolean" ? vision : undefined;
}

/**
 * The context window of a llama.cpp server's loaded model, when it reports one.
 *
 * `n_ctx` is what the server was started with (`--ctx-size`), so it is the real
 * limit a request has to fit in — older builds put it on the payload, newer ones
 * inside `default_generation_settings`.
 */
function contextWindowFromProps(props: Record<string, unknown>): number | undefined {
  const settings = props.default_generation_settings;
  const nested =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>).n_ctx
      : undefined;
  const nCtx = typeof nested === "number" ? nested : props.n_ctx;
  if (typeof nCtx !== "number" || !Number.isInteger(nCtx) || nCtx <= 0) return undefined;
  return nCtx;
}

function toStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

/**
 * Whether a `/props` payload provably describes `modelId`.
 *
 * A server that ignores the `?model=` parameter answers with whichever model it
 * has loaded — attributing that to every listed model would mark text-only ones
 * vision-capable, so an unprovable answer is treated as no answer.
 */
function propsIdentifyModel(props: Record<string, unknown>, modelId: string): boolean {
  if (toStringList(props.model_alias).includes(modelId)) return true;

  const modelPath = typeof props.model_path === "string" ? props.model_path : null;
  if (!modelPath) return false;
  const normalized = modelPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/");
  // Either the GGUF is named after the model, or it sits in a directory that is
  // (`.../Qwen3-VL-8B/Qwen3-VL-8B-Q4_K_M.gguf` — how the router names its models).
  return segments[segments.length - 1] === modelId || segments[segments.length - 2] === modelId;
}

/**
 * What the endpoint reports about one model, or `undefined` when it cannot be
 * made to answer for it.
 */
async function probeModel(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  options: { plain: boolean; deadline: number },
): Promise<ModelCapabilities | undefined> {
  const remaining = Math.min(PROBE_TIMEOUT_MS, options.deadline - Date.now());
  if (remaining <= 0) return undefined;

  const url = options.plain
    ? `${baseUrl}/props`
    : `${baseUrl}/props?model=${encodeURIComponent(modelId)}`;
  const props = await fetchJsonObject(url, apiKey, remaining);
  if (!props) return undefined;
  if (!options.plain && !propsIdentifyModel(props, modelId)) return undefined;

  const capabilities: ModelCapabilities = {};
  const vision = visionFromProps(props);
  if (vision !== undefined) capabilities.vision = vision;
  const contextWindow = contextWindowFromProps(props);
  if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

export interface CapabilityDetectionResult {
  /** Capabilities the endpoint reported, keyed by model id. */
  capabilities: ModelCapabilityMap;
  /** Models left unprobed (budget exhausted, or beyond the probe cap). */
  unprobed: number;
}

/** What an endpoint's `/models` listing states about one of its models. */
export interface ListedModel {
  id: string;
  /** Whatever the listing stated; empty when it said nothing. */
  capabilities: ModelCapabilities;
}

export interface EndpointListing {
  models: ListedModel[];
  /**
   * Whether the endpoint swaps models in on demand — llama-swap and the like
   * answer a per-model `/props` probe by loading that model, evicting the one in
   * use and taking as long as a load takes.
   */
  loadOnDemand: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The context window a listing entry states, in the names servers use for it.
 *
 * vLLM reports `max_model_len`, LM Studio `max_context_length`, llama-swap
 * `context_length`/`context_window` plus its own `meta.n_ctx`.
 */
function listedContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const key of ["context_length", "context_window", "max_model_len", "max_context_length"]) {
    const value = positiveInteger(entry[key]);
    if (value !== undefined) return value;
  }
  const meta = asRecord(entry.meta);
  return positiveInteger(meta?.n_ctx) ?? positiveInteger(asRecord(meta?.llamaswap)?.n_ctx);
}

/** Whether a listing entry says the model takes images. */
function listedVision(entry: Record<string, unknown>): boolean | undefined {
  const capabilities = asRecord(entry.capabilities);
  if (typeof capabilities?.vision === "boolean") return capabilities.vision;

  const modalities = asRecord(entry.architecture)?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes("image");

  const meta = asRecord(entry.meta);
  const vision =
    asRecord(asRecord(meta?.llamaswap)?.modalities)?.vision ?? asRecord(meta?.modalities)?.vision;
  return typeof vision === "boolean" ? vision : undefined;
}

/**
 * Read an OpenAI-compatible `/models` payload.
 *
 * Most servers list ids and nothing else, but the ones that state a model's
 * window or modalities save the user from typing them — and both llama-swap and
 * vLLM state the window without loading anything.
 */
export function parseEndpointListing(payload: unknown): EndpointListing {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return { models: [], loadOnDemand: false };

  const models: ListedModel[] = [];
  let loadOnDemand = false;

  for (const raw of data) {
    const entry = asRecord(raw);
    const id = entry?.id;
    if (typeof id !== "string" || id.length === 0) continue;

    // llama-swap marks its own listing; a probe would load a model.
    if (entry?.owned_by === "llama-swap" || asRecord(entry?.meta)?.llamaswap !== undefined) {
      loadOnDemand = true;
    }

    const capabilities: ModelCapabilities = {};
    const contextWindow = listedContextWindow(entry!);
    if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
    const vision = listedVision(entry!);
    if (vision !== undefined) capabilities.vision = vision;

    models.push({ id, capabilities });
  }

  return { models, loadOnDemand };
}

/**
 * Ask an OpenAI-compatible endpoint what its models can do and how big each
 * window is.
 *
 * Two sources, in order of cost. The listing is free (it was fetched anyway) and
 * already answers for llama-swap, vLLM and LM Studio. `/props` is how a bare
 * llama-server states the `n_ctx` it was started with, but it is only asked for
 * models the listing left unknown, and never of a load-on-demand proxy — where
 * the answer would cost a model swap.
 *
 * Everything else falls through with an empty answer, which the UI presents as
 * "set it by hand" rather than as "no vision" and "no window".
 */
export async function detectModelCapabilities(options: {
  baseUrl: string;
  apiKey?: string | undefined;
  modelIds: string[];
  /** What the listing already stated, keyed by model id. */
  reported?: ModelCapabilityMap | undefined;
  /** Skip `/props` entirely — the endpoint loads models on demand. */
  loadOnDemand?: boolean | undefined;
  budgetMs?: number;
}): Promise<CapabilityDetectionResult> {
  const baseUrl = introspectionBaseUrl(options.baseUrl);
  const allModelIds = [...new Set(options.modelIds.filter(Boolean))];
  const modelIds = allModelIds.slice(0, MAX_PROBED_MODELS);
  if (allModelIds.length > modelIds.length) {
    console.warn(
      `Model capability detection skipped ${allModelIds.length - modelIds.length} of ${allModelIds.length} models at ${baseUrl} (probe cap ${MAX_PROBED_MODELS})`,
    );
  }

  const capabilities: ModelCapabilityMap = {};
  for (const modelId of allModelIds) {
    const reported = options.reported?.[modelId];
    if (reported) capabilities[modelId] = { ...reported };
  }

  // `/props` only adds what the listing could not say, and a proxy would charge
  // a model load for the asking.
  const unprobedIds = modelIds.filter(
    (modelId) => !options.loadOnDemand && capabilities[modelId]?.vision === undefined,
  );
  if (unprobedIds.length === 0) {
    return { capabilities, unprobed: allModelIds.length - Object.keys(capabilities).length };
  }

  const deadline = Date.now() + (options.budgetMs ?? DETECTION_BUDGET_MS);

  if (allModelIds.length === 1) {
    // A single-model endpoint has exactly one `modalities` to report, and the
    // unparameterised probe answers for it — no name matching needed.
    const modelId = unprobedIds[0]!;
    const probed = await probeModel(baseUrl, options.apiKey, modelId, {
      plain: true,
      deadline,
    });
    if (probed) capabilities[modelId] = { ...capabilities[modelId], ...probed };
  } else {
    for (let index = 0; index < unprobedIds.length; index += PROBE_CONCURRENCY) {
      if (Date.now() >= deadline) break;
      const batch = unprobedIds.slice(index, index + PROBE_CONCURRENCY);
      const probed = await Promise.all(
        batch.map((modelId) =>
          probeModel(baseUrl, options.apiKey, modelId, { plain: false, deadline }),
        ),
      );
      for (const [offset, modelId] of batch.entries()) {
        const answer = probed[offset];
        if (answer) capabilities[modelId] = { ...capabilities[modelId], ...answer };
      }
    }
  }

  // Every listed model the endpoint did not answer for: the caller reports it
  // rather than presenting a silent "no vision here" for the whole provider.
  return { capabilities, unprobed: allModelIds.length - Object.keys(capabilities).length };
}

/** A token limit read out of stored JSON, or `undefined` when it is not one. */
function storedTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Read a capability map out of stored JSON, ignoring anything malformed. */
export function parseModelCapabilityMap(value: unknown): ModelCapabilityMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const map: ModelCapabilityMap = {};
  for (const [modelId, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;

    const raw = entry as Record<string, unknown>;
    const capabilities: ModelCapabilities = {};
    if (typeof raw.vision === "boolean") capabilities.vision = raw.vision;
    const contextWindow = storedTokenLimit(raw.contextWindow);
    if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
    const maxOutputTokens = storedTokenLimit(raw.maxOutputTokens);
    if (maxOutputTokens !== undefined) capabilities.maxOutputTokens = maxOutputTokens;

    if (Object.keys(capabilities).length > 0) map[modelId] = capabilities;
  }
  return map;
}

/** The vision flag recorded for a model (detected, or set by hand), if any. */
export function configuredVision(map: ModelCapabilityMap, modelId: string): boolean | undefined {
  const vision = map[modelId]?.vision;
  return typeof vision === "boolean" ? vision : undefined;
}

/** The token limits recorded for a model, with nothing inherited. */
export function configuredLimits(
  map: ModelCapabilityMap,
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } {
  const entry = map[modelId];
  const limits: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof entry?.contextWindow === "number") limits.contextWindow = entry.contextWindow;
  if (typeof entry?.maxOutputTokens === "number") limits.maxOutputTokens = entry.maxOutputTokens;
  return limits;
}

/** A copy of `map` with `modelId`'s vision flag set. */
export function withModelVision(
  map: ModelCapabilityMap,
  modelId: string,
  vision: boolean,
): ModelCapabilityMap {
  return { ...map, [modelId]: { ...map[modelId], vision } };
}

/** A copy of `map` with `modelId` back on automatic capability detection. */
export function withoutModelVision(map: ModelCapabilityMap, modelId: string): ModelCapabilityMap {
  const next = { ...map };
  const entry = next[modelId];
  if (!entry) return next;
  const { vision: _vision, ...rest } = entry;
  if (Object.keys(rest).length === 0) delete next[modelId];
  else next[modelId] = rest;
  return next;
}

/**
 * A copy of `map` with some of `modelId`'s limits set.
 *
 * `null` clears one field so the model inherits the endpoint's default again; a
 * field the caller omits is left exactly as stored.
 */
export function withModelLimits(
  map: ModelCapabilityMap,
  modelId: string,
  limits: {
    contextWindow?: number | null | undefined;
    maxOutputTokens?: number | null | undefined;
  },
): ModelCapabilityMap {
  const next = { ...map };
  const entry: ModelCapabilities = { ...next[modelId] };

  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const value = limits[field];
    if (value === undefined) continue;
    if (value === null) delete entry[field];
    else entry[field] = value;
  }

  if (Object.keys(entry).length === 0) delete next[modelId];
  else next[modelId] = entry;
  return next;
}

/**
 * The stored form of a capability map.
 *
 * Prisma's JSON input rejects `undefined`, which an optional flag projects into
 * a map's type — and a model with nothing set is stored as nothing at all, so an
 * "auto" model never looks like an explicit answer.
 */
export function serializeModelCapabilityMap(
  map: ModelCapabilityMap,
): Record<string, Record<string, boolean | number>> {
  const serialized: Record<string, Record<string, boolean | number>> = {};
  for (const [modelId, capabilities] of Object.entries(map)) {
    const entry: Record<string, boolean | number> = {};
    if (typeof capabilities.vision === "boolean") entry.vision = capabilities.vision;
    if (typeof capabilities.contextWindow === "number") {
      entry.contextWindow = capabilities.contextWindow;
    }
    if (typeof capabilities.maxOutputTokens === "number") {
      entry.maxOutputTokens = capabilities.maxOutputTokens;
    }
    if (Object.keys(entry).length > 0) serialized[modelId] = entry;
  }
  return serialized;
}

/**
 * Fold freshly detected capabilities into the stored ones.
 *
 * Detection wins per field where it answered — an explicit refresh asks the
 * endpoint, and the endpoint is the authority on what it loaded — while
 * everything it could not answer for keeps whatever the user (or a previous
 * sweep) recorded. Merging per field rather than per model is what stops a
 * detected vision flag from dropping a window the user typed by hand.
 */
export function mergeDetectedCapabilities(
  stored: ModelCapabilityMap,
  detected: ModelCapabilityMap,
): ModelCapabilityMap {
  const merged: ModelCapabilityMap = { ...stored };
  for (const [modelId, capabilities] of Object.entries(detected)) {
    merged[modelId] = { ...merged[modelId], ...capabilities };
  }
  return merged;
}

/** Validate a capability edit from a request body. */
export function parseVisionEdit(body: {
  modelId?: unknown;
  vision?: unknown;
}): { modelId: string; vision: boolean | null } | { error: string } {
  const modelId = body.modelId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    return { error: "modelId is required" };
  }
  if (body.vision === null || body.vision === undefined) return { modelId, vision: null };
  if (typeof body.vision !== "boolean") {
    return { error: "vision must be a boolean, or null to reset to auto" };
  }
  return { modelId, vision: body.vision };
}

/**
 * The input types a model definition should claim.
 *
 * A configured flag wins: an endpoint that misreports itself (or says nothing)
 * must not overrule the person who runs it.
 */
export function resolveModelInput(
  knownInput: readonly ("text" | "image")[] | undefined,
  vision: boolean | undefined,
): ("text" | "image")[] {
  if (vision === true) return ["text", "image"];
  if (vision === false) return ["text"];
  return knownInput ? [...knownInput] : ["text"];
}
