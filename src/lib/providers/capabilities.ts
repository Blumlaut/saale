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
 */

/** What Saale knows about one discovered model. */
export interface ModelCapabilities {
  /** Whether the model accepts image input. Absent = not known. */
  vision?: boolean;
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
 * Vision support for one model, or `undefined` when the endpoint cannot be made
 * to answer for it.
 */
async function probeVision(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  options: { plain: boolean; deadline: number },
): Promise<boolean | undefined> {
  const remaining = Math.min(PROBE_TIMEOUT_MS, options.deadline - Date.now());
  if (remaining <= 0) return undefined;

  const url = options.plain
    ? `${baseUrl}/props`
    : `${baseUrl}/props?model=${encodeURIComponent(modelId)}`;
  const props = await fetchJsonObject(url, apiKey, remaining);
  if (!props) return undefined;
  if (!options.plain && !propsIdentifyModel(props, modelId)) return undefined;
  return visionFromProps(props);
}

export interface CapabilityDetectionResult {
  /** Capabilities the endpoint reported, keyed by model id. */
  capabilities: ModelCapabilityMap;
  /** Models left unprobed (budget exhausted, or beyond the probe cap). */
  unprobed: number;
}

/**
 * Ask an OpenAI-compatible endpoint what its models can do.
 *
 * Only llama.cpp answers today — its `/props` reports the projector it loaded,
 * per model when it serves a directory of them (`?model=`). Every other endpoint
 * falls through with an empty answer, which the UI presents as "set it by hand"
 * rather than as "no vision".
 */
export async function detectModelCapabilities(options: {
  baseUrl: string;
  apiKey?: string | undefined;
  modelIds: string[];
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
  const deadline = Date.now() + (options.budgetMs ?? DETECTION_BUDGET_MS);
  const capabilities: ModelCapabilityMap = {};

  if (modelIds.length === 0) return { capabilities, unprobed: 0 };

  if (modelIds.length === 1) {
    // A single-model endpoint has exactly one `modalities` to report, and the
    // unparameterised probe answers for it — no name matching needed.
    const modelId = modelIds[0]!;
    const vision = await probeVision(baseUrl, options.apiKey, modelId, {
      plain: true,
      deadline,
    });
    if (vision !== undefined) capabilities[modelId] = { vision };
  } else {
    for (let index = 0; index < modelIds.length; index += PROBE_CONCURRENCY) {
      if (Date.now() >= deadline) break;
      const batch = modelIds.slice(index, index + PROBE_CONCURRENCY);
      const probed = await Promise.all(
        batch.map((modelId) =>
          probeVision(baseUrl, options.apiKey, modelId, { plain: false, deadline }),
        ),
      );
      for (const [offset, modelId] of batch.entries()) {
        const vision = probed[offset];
        if (vision !== undefined) capabilities[modelId] = { vision };
      }
    }
  }

  // Every listed model the endpoint did not answer for: the caller reports it
  // rather than presenting a silent "no vision here" for the whole provider.
  return { capabilities, unprobed: allModelIds.length - Object.keys(capabilities).length };
}

/** Read a capability map out of stored JSON, ignoring anything malformed. */
export function parseModelCapabilityMap(value: unknown): ModelCapabilityMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const map: ModelCapabilityMap = {};
  for (const [modelId, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const vision = (entry as Record<string, unknown>).vision;
    if (typeof vision === "boolean") map[modelId] = { vision };
  }
  return map;
}

/** The vision flag recorded for a model (detected, or set by hand), if any. */
export function configuredVision(map: ModelCapabilityMap, modelId: string): boolean | undefined {
  const vision = map[modelId]?.vision;
  return typeof vision === "boolean" ? vision : undefined;
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
 * The stored form of a capability map.
 *
 * Prisma's JSON input rejects `undefined`, which an optional flag projects into
 * a map's type — and a model with nothing set is stored as nothing at all, so an
 * "auto" model never looks like an explicit answer.
 */
export function serializeModelCapabilityMap(
  map: ModelCapabilityMap,
): Record<string, Record<string, boolean>> {
  const serialized: Record<string, Record<string, boolean>> = {};
  for (const [modelId, capabilities] of Object.entries(map)) {
    const entry: Record<string, boolean> = {};
    if (typeof capabilities.vision === "boolean") entry.vision = capabilities.vision;
    if (Object.keys(entry).length > 0) serialized[modelId] = entry;
  }
  return serialized;
}

/**
 * Fold freshly detected capabilities into the stored ones.
 *
 * Detection wins where it answered — an explicit refresh asks the endpoint, and
 * the endpoint is the authority on what it loaded — while models it could not
 * answer for keep whatever the user (or a previous sweep) recorded.
 */
export function mergeDetectedCapabilities(
  stored: ModelCapabilityMap,
  detected: ModelCapabilityMap,
): ModelCapabilityMap {
  return { ...stored, ...detected };
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
