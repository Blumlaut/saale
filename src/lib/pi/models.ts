import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import {
  parseModelCapabilityMap,
  resolveModelInput,
  configuredVision,
  type ModelCapabilityMap,
} from "@/lib/providers/capabilities";
import { CUSTOM_PROVIDER_ID, CUSTOM_PROVIDER_LABEL } from "@/lib/providers/config";
import {
  createProviderCredentialStore,
  type ProviderScope,
} from "@/lib/providers/credential-store";
import { limitFields, type ProviderModelLimits } from "@/lib/providers/limits";
import { createModelsStore, refreshModelCatalogInBackground } from "@/lib/providers/models-store";

interface ProviderModelConfig {
  enabled: boolean;
  models?: string[];
}

/**
 * A model offered to the UI. `reasoning` and `contextWindow` describe what Pi's
 * catalog knows about it; a discovered model Pi has no entry for reports no
 * context window rather than a guessed one. `vision` is whether the resolved
 * definition accepts image input, so pickers can say which models can look at
 * a picture before one is sent.
 */
export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean | undefined;
  contextWindow?: number | undefined;
  vision: boolean;
}

/** A model definition passed to `registerProvider`. */
type ProviderModelDefinition = Parameters<ModelRuntime["registerProvider"]>[1]["models"] extends
  (infer T)[] | undefined
  ? T
  : never;

/**
 * Fetch global admin model config.
 */
async function getGlobalModelConfig() {
  const settings = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { globalProviderModels: true },
  });

  return (settings?.globalProviderModels as unknown as Record<string, ProviderModelConfig>) ?? null;
}

/**
 * Whether the admin's global configuration allows a model.
 *
 * The admin stores one entry per provider they have configured:
 *
 * - `enabled: false` is the provider switch — every model of that provider is
 *   off.
 * - a non-empty `models` list is an allowlist.
 * - anything else (no entry, or an entry without a model list) means "no
 *   restriction".
 *
 * An *empty* list deliberately means the same as no list. It used to mean "all
 * disabled", but the admin UI cannot tell an empty selection from a provider it
 * simply saved without touching, so a single Save silently switched off every
 * model of every provider the admin had not toggled — including a local
 * endpoint's, which then also disappeared from the very list used to switch it
 * back on. Turning a provider off is what the provider switch (`enabled`) is
 * for.
 */
function isModelAllowed(
  globalConfig: Record<string, ProviderModelConfig> | null,
  provider: string,
  modelId: string,
): boolean {
  if (!globalConfig) return true;

  const providerConfig = globalConfig[provider];
  if (!providerConfig) return true; // not in config = allowed

  if (providerConfig.enabled === false) return false;

  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models.includes(modelId);
  }

  return true;
}

/**
 * Fetch model IDs from an OpenAI-compatible /models endpoint.
 */
export async function fetchOpenAIModels(baseUrl: string, apiKey?: string): Promise<string[]> {
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
      return [];
    }

    const data = await res.json();
    if (!data?.data?.length) return [];

    return data.data.map((m: { id: string }) => String(m.id)).slice(0, 500);
  } catch (err) {
    console.error(`Error fetching models from ${url}:`, err);
    return [];
  }
}

/**
 * A model definition for an id returned by an OpenAI-compatible endpoint.
 *
 * Pi's `registerProvider` **replaces** a provider's model list — the extension's
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
 * Pi has never heard of) fall back to conservative values — and a recorded
 * capability wins over both, because the endpoint that serves the model
 * (or the person running it) knows better than the catalog does.
 *
 * Only Saale's own OpenAI-compatible endpoint goes through this path: every
 * provider Pi defines is served by Pi's catalog, with all of its metadata.
 */
function defineDiscoveredModel(
  runtime: ModelRuntime,
  provider: string,
  id: string,
  limits: ProviderModelLimits,
  capabilities: ModelCapabilityMap,
): ProviderModelDefinition {
  const known = runtime.getModel(provider, id);
  const vision = configuredVision(capabilities, id);

  if (known) {
    return {
      id,
      name: known.name || id,
      api: known.api,
      reasoning: known.reasoning,
      input: resolveModelInput(known.input, vision),
      cost: known.cost,
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
    };
  }

  // Unknown to Pi: claim nothing it cannot do, and use the user's limits.
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    reasoning: false,
    input: resolveModelInput(undefined, vision),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limitFields(limits),
  };
}

/**
 * Register a provider from its `/models` listing.
 *
 * Used for Saale's own OpenAI-compatible endpoint, whose models Pi cannot know.
 * The admin model browser registers the global endpoint the same way, so both
 * see the same models.
 *
 * @returns The model ids the provider listed (empty when discovery failed).
 */
export async function registerDiscoveredModels(
  runtime: ModelRuntime,
  options: {
    provider: string;
    baseUrl: string;
    apiKey?: string | undefined;
    limits: ProviderModelLimits;
    capabilities?: ModelCapabilityMap | undefined;
  },
): Promise<string[]> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const modelIds = await fetchOpenAIModels(baseUrl, options.apiKey);
  const capabilities = options.capabilities ?? {};

  runtime.registerProvider(options.provider, {
    baseUrl,
    apiKey: options.apiKey || "placeholder",
    api: "openai-completions",
    ...(modelIds.length > 0
      ? {
          models: modelIds.map((m) =>
            defineDiscoveredModel(runtime, options.provider, m, options.limits, capabilities),
          ),
        }
      : {}),
  });

  return modelIds;
}

/**
 * Register the scope's OpenAI-compatible endpoint, if it has one.
 *
 * Its API key goes through `setRuntimeApiKey` rather than the credential store:
 * Pi has no auth flow for an endpoint it does not know, and the limits and
 * per-model capabilities Saale records are what describe its models.
 */
async function registerCustomEndpoint(modelRuntime: ModelRuntime, scope: ProviderScope) {
  const select = {
    baseUrl: true,
    encryptedKey: true,
    contextWindow: true,
    maxOutputTokens: true,
    modelCapabilities: true,
  } as const;

  // One endpoint per scope. A user's own endpoint wins; otherwise they inherit
  // the global one, exactly as they inherit a provider credential — an admin's
  // local endpoint is usable by everyone, and its models must be pickable for
  // everyone.
  const own =
    scope.kind === "user"
      ? await prisma.providerApiKey.findUnique({
          where: { userId_provider: { userId: scope.userId, provider: CUSTOM_PROVIDER_ID } },
          select,
        })
      : null;

  // The global scope has no compound-unique lookup (Prisma types
  // `userId_provider.userId` as non-null), so it reads the row by its columns.
  const row =
    own ??
    (await prisma.providerApiKey.findFirst({
      where: { userId: null, provider: CUSTOM_PROVIDER_ID },
      select,
    }));

  const baseUrl = row?.baseUrl;
  if (!baseUrl) return [];

  let apiKey: string | undefined;
  try {
    apiKey = decrypt(row.encryptedKey) || undefined;
  } catch (err) {
    // A key that cannot be decrypted still leaves the endpoint usable (a local
    // server needs none), so report it and continue.
    console.error(`Failed to decrypt the ${CUSTOM_PROVIDER_LABEL} API key:`, err);
  }

  if (apiKey) {
    await modelRuntime.setRuntimeApiKey(CUSTOM_PROVIDER_ID, apiKey);
  }

  return registerDiscoveredModels(modelRuntime, {
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    apiKey,
    limits: { contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens },
    capabilities: parseModelCapabilityMap(row.modelCapabilities),
  });
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
 * sessions are the caller's business — this is only the model world.
 */
async function buildRuntime(scope: ProviderScope, options: BuildRuntimeOptions = {}) {
  const globalConfig = await getGlobalModelConfig();

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

  const discovered = await registerCustomEndpoint(modelRuntime, scope);

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
    vision: m.input.includes("image"),
  }));

  // The custom endpoint's models are registered above; carry the ones the
  // availability snapshot has not picked up yet.
  const knownIds = new Set(allModels.map((m) => `${m.provider}:${m.id}`));
  for (const id of discovered) {
    if (knownIds.has(`${CUSTOM_PROVIDER_ID}:${id}`)) continue;
    const model = modelRuntime.getModel(CUSTOM_PROVIDER_ID, id);
    allModels.push({
      provider: CUSTOM_PROVIDER_ID,
      id,
      name: model?.name ?? id,
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.contextWindow,
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
