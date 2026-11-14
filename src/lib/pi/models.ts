import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  parseEndpointListing,
  parseModelCapabilityMap,
  resolveModelInput,
  configuredImage,
  configuredLimits,
  configuredVision,
  type EndpointListing,
  type ModelCapabilities,
  type ModelCapabilityMap,
} from "@/lib/providers/capabilities";
import { CUSTOM_PROVIDER_LABEL } from "@/lib/providers/config";
import {
  createProviderCredentialStore,
  type ProviderScope,
} from "@/lib/providers/credential-store";
import { endpointApiKey, endpointName, readEndpointRows } from "@/lib/providers/endpoint";
import { resolveModelLimits, type ProviderModelLimits } from "@/lib/providers/limits";
import {
  generateImages as generateOpenAIImages,
  OPENAI_IMAGES_API,
} from "@/lib/providers/images/openai-images";
import { isModelAllowed, readGlobalModelConfig } from "@/lib/providers/model-availability";
import { createModelsStore, refreshModelCatalogInBackground } from "@/lib/providers/models-store";

/**
 * A model offered to the UI. `reasoning`, `contextWindow` and `maxOutputTokens`
 * describe what Pi will actually send, resolved from the model catalog and any
 * limit Saale records for it. `vision` is whether the resolved definition
 * accepts image input, so pickers can say which models can look at a picture
 * before one is sent.
 */
export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  vision: boolean;
}

/** A model definition passed to `registerProvider`. */
type ProviderModelDefinition = Parameters<ModelRuntime["registerProvider"]>[1]["models"] extends
  (infer T)[] | undefined
  ? T
  : never;

/**
 * An OpenAI-compatible endpoint's `/models` listing.
 *
 * A failed listing is empty rather than fatal: building the runtime must not
 * depend on a local server being up.
 */
export async function fetchEndpointListing(
  baseUrl: string,
  apiKey?: string,
): Promise<EndpointListing> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`Failed to fetch models from ${url}: HTTP ${res.status}`);
      return { models: [], loadOnDemand: false };
    }

    const listing = parseEndpointListing(await res.json());
    return { models: listing.models.slice(0, 500), loadOnDemand: listing.loadOnDemand };
  } catch (err) {
    console.error(`Error fetching models from ${url}:`, err);
    return { models: [], loadOnDemand: false };
  }
}

/**
 * Model ids from an OpenAI-compatible `/models` endpoint.
 */
export async function fetchOpenAIModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const listing = await fetchEndpointListing(baseUrl, apiKey);
  return listing.models.map((model) => model.id);
}

/**
 * A model definition for an id returned by an OpenAI-compatible endpoint.
 *
 * Pi's `registerProvider` **replaces** a provider's model list. the extension's
 * `models` are composed over the catalog, not merged into it
 * (`applyExtension` in the SDK's `provider-composer.js`), and a definition only
 * inherits `api`/`baseUrl` from the catalog entry it shadows. Everything else
 * must be stated here, so a definition built from "id + name" alone downgrades
 * a model Pi knows well: `reasoning: false` makes thinking impossible,
 * `input: ["text"]` silently drops every image from the request (while
 * `["text", "image"]` on a text-only endpoint is answered with a 400), and zero
 * cost plus Pi's default limits hide the real context window.
 *
 * A catalog hit is therefore used verbatim; only genuinely unknown ids (a model
 * Pi has never heard of) fall back to conservative values. and a recorded
 * capability or limit wins over both, because the endpoint that serves the
 * model (or the person running it) knows better than the catalog does.
 *
 * Only Saale's own OpenAI-compatible endpoint goes through this path: every
 * provider Pi defines is served by Pi's catalog, with all of its metadata.
 */
function defineDiscoveredModel(
  runtime: ModelRuntime,
  provider: string,
  id: string,
  options: {
    limits: ProviderModelLimits;
    capabilities: ModelCapabilityMap;
    /** What the endpoint's own listing states for this model. */
    reported?: ModelCapabilities | undefined;
  },
): ProviderModelDefinition {
  const known = runtime.getModel(provider, id);
  const { limits, capabilities, reported } = options;

  return {
    id,
    name: known?.name || id,
    api: known?.api ?? ("openai-completions" as const),
    reasoning: known?.reasoning ?? false,
    input: resolveModelInput(known?.input, configuredVision(capabilities, id) ?? reported?.vision),
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...resolveModelLimits({
      model: configuredLimits(capabilities, id),
      endpoint: limits,
      reported,
      catalog: known,
    }),
  };
}

/**
 * A decision model from an endpoint's listing.
 *
 * It answers typed questions about a state instead of chatting, so Pi lists it
 * as a classifier rather than a chat model. The approval gate asks it about the
 * calls Auto would run (see `decision-model.ts`).
 */
function defineDecisionModel(
  id: string,
  options: { limits: ProviderModelLimits; capabilities: ModelCapabilityMap },
): ProviderModelDefinition {
  const { limits, capabilities } = options;
  return {
    id,
    name: id,
    type: "classifier",
    api: "typesafe-system-one",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveModelLimits({
      model: configuredLimits(capabilities, id),
      endpoint: limits,
    }).contextWindow,
  };
}

/**
 * An image model from an endpoint's listing, or one the user marked as such.
 *
 * It produces images instead of answering, so Pi lists it apart from the chat
 * models. `openai-images` is the adapter this module registers for the
 * provider, and the endpoint decides whether it serves `/v1/images/edits` for
 * the reference images it is offered.
 */
function defineImageModel(id: string): ProviderModelDefinition {
  return {
    id,
    name: id,
    type: "image",
    api: OPENAI_IMAGES_API,
    input: ["text", "image"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Register a provider from its `/models` listing.
 *
 * Used for Saale's own OpenAI-compatible endpoints, whose models Pi cannot know.
 * The admin model browser registers the global endpoints the same way, so both
 * see the same models.
 *
 * @returns The chat model ids the provider listed (empty when discovery failed).
 *   Its decision models are registered as classifiers, which the chat model
 *   pickers never list.
 */
export async function registerDiscoveredModels(
  runtime: ModelRuntime,
  options: {
    provider: string;
    /** What the provider goes by in the UI. */
    name?: string | undefined;
    baseUrl: string;
    apiKey?: string | undefined;
    limits: ProviderModelLimits;
    capabilities?: ModelCapabilityMap | undefined;
  },
): Promise<string[]> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const listing = await fetchEndpointListing(baseUrl, options.apiKey);
  const capabilities = options.capabilities ?? {};
  const reported = new Map(listing.models.map((model) => [model.id, model.capabilities]));
  const isImage = (model: { id: string; imageModel?: true }): boolean =>
    model.imageModel === true || configuredImage(capabilities, model.id) === true;
  const chatModels = listing.models.filter((model) => !model.decisionModel && !isImage(model));

  runtime.registerProvider(options.provider, {
    name: options.name?.trim() || CUSTOM_PROVIDER_LABEL,
    baseUrl,
    apiKey: options.apiKey || "placeholder",
    api: "openai-completions",
    ...(listing.models.length > 0
      ? {
          models: listing.models.map((model) => {
            if (model.decisionModel) {
              return defineDecisionModel(model.id, { limits: options.limits, capabilities });
            }
            if (isImage(model)) return defineImageModel(model.id);
            return defineDiscoveredModel(runtime, options.provider, model.id, {
              limits: options.limits,
              capabilities,
              reported: reported.get(model.id),
            });
          }),
        }
      : {}),
    // The provider serves the OpenAI images API for the image models it lists.
    ...(listing.models.some(isImage)
      ? { images: { [OPENAI_IMAGES_API]: { generateImages: generateOpenAIImages } } }
      : {}),
    // `/v1/systemone` is TypeSafe's protocol, so Pi's own implementation calls
    // the decision models the endpoint serves.
    ...(listing.models.some((model) => model.decisionModel)
      ? { classifiers: { "typesafe-system-one": { classify } } }
      : {}),
  });

  return chatModels.map((model) => model.id);
}

/**
 * Register every OpenAI-compatible endpoint the scope can use.
 *
 * The API key goes through `setRuntimeApiKey` rather than the credential store:
 * Pi has no auth flow for an endpoint it does not know, and the limits and
 * per-model capabilities Saale records are what describe its models.
 *
 * @returns One entry per discovered model, tagged with the endpoint serving it.
 */
async function registerCustomEndpoints(
  modelRuntime: ModelRuntime,
  scope: ProviderScope,
): Promise<Array<{ provider: string; id: string }>> {
  const rows = await readEndpointRows(scope);
  const discovered: Array<{ provider: string; id: string }> = [];

  for (const row of rows) {
    const baseUrl = row.baseUrl;
    if (!baseUrl) continue;

    const apiKey = endpointApiKey(row);
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(row.provider, apiKey);
    }

    const ids = await registerDiscoveredModels(modelRuntime, {
      provider: row.provider,
      name: endpointName(row),
      baseUrl,
      apiKey,
      limits: { contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens },
      capabilities: parseModelCapabilityMap(row.modelCapabilities),
    });
    discovered.push(...ids.map((id) => ({ provider: row.provider, id })));
  }

  return discovered;
}

/** How a runtime's model list is derived. */
interface BuildRuntimeOptions {
  /**
   * Whether to drop models the admin switched off. The admin's own model list
   * passes `false`: it has to show a switched-off model in order to switch it
   * back on.
   */
  applyModelFilter?: boolean;
}

/**
 * Build the Pi model runtime for a credential scope, with every model that
 * scope can call.
 *
 * Pi owns the providers, the models and the auth: its catalog describes each
 * model, its credential store resolves each provider, and its catalog overlay
 * keeps the lists current. Saale supplies storage for both stores and never
 * enumerates a provider itself.
 *
 * Models are filtered by the global admin config (if any). `customTools` and
 * sessions are the caller's business. this is only the model world.
 */
async function buildRuntime(scope: ProviderScope, options: BuildRuntimeOptions = {}) {
  const globalConfig = await readGlobalModelConfig();

  const modelRuntime = await ModelRuntime.create({
    // Credentials come from the database. `ModelRuntime.create()` would
    // otherwise read the host's ~/.pi/agent/auth.json, models.json and
    // models-store.json (SDK docs, "Credential priority"), handing every tenant
    // the operator's provider keys, private endpoints and catalog cache.
    credentials: createProviderCredentialStore(scope),
    modelsPath: null,
    modelsStore: createModelsStore(),
    // Answer this request from the cached catalog; the overlay that a fetch
    // produces is picked up by the next runtime (see below).
    allowModelNetwork: false,
  });

  const discovered = await registerCustomEndpoints(modelRuntime, scope);

  // Detached, throttled, and skipped entirely under PI_OFFLINE: Pi publishes a
  // per-provider catalog so a model that shipped after the installed package is
  // still selectable.
  refreshModelCatalogInBackground(modelRuntime);

  const available = modelRuntime.getAvailableSnapshot();
  const allModels: AvailableModel[] = available.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxTokens,
    vision: m.input.includes("image"),
  }));

  // The endpoints' models are registered above; carry the ones the availability
  // snapshot has not picked up yet.
  const knownIds = new Set(allModels.map((m) => `${m.provider}:${m.id}`));
  for (const { provider, id } of discovered) {
    if (knownIds.has(`${provider}:${id}`)) continue;
    const model = modelRuntime.getModel(provider, id);
    allModels.push({
      provider,
      id,
      name: model?.name ?? id,
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.contextWindow,
      maxOutputTokens: model?.maxTokens,
      vision: model?.input.includes("image") ?? false,
    });
  }

  const models =
    options.applyModelFilter === false
      ? allModels
      : allModels.filter((m) => isModelAllowed(globalConfig, m.provider, m.id));

  return { modelRuntime, models };
}

/** Build the model runtime for one user, with every provider they can reach. */
export function buildModelRuntime(userId: string) {
  return buildRuntime({ kind: "user", userId });
}

/** Build the model runtime for the global (admin) provider configuration. */
export function buildGlobalModelRuntime() {
  return buildRuntime({ kind: "global" });
}

/**
 * Build the global configuration's runtime for the admin's model list: every
 * model the configuration can offer, including the ones currently switched off.
 */
export function buildAdminModelList() {
  return buildRuntime({ kind: "global" }, { applyModelFilter: false });
}
