import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { DISCOVERABLE_PROVIDERS, getProviderBaseUrl } from "@/lib/providers/config";
import { limitFields, type ProviderModelLimits } from "@/lib/providers/limits";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

interface ProviderModelConfig {
  enabled: boolean;
  models?: string[];
}

/**
 * A model offered to the UI. `reasoning` and `contextWindow` describe what Pi's
 * catalog knows about it; a discovered model Pi has no entry for reports no
 * context window rather than a guessed one.
 */
export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean | undefined;
  contextWindow?: number | undefined;
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
 * Check if a model is allowed by the global config.
 * - If no global config exists, all models are allowed.
 * - If provider has an explicit model list, only those models are allowed.
 * - If provider has an empty model list, no models from it are allowed.
 * - If provider is not in config, all models from it are allowed.
 */
function isModelAllowed(
  globalConfig: Record<string, ProviderModelConfig> | null,
  provider: string,
  modelId: string,
): boolean {
  if (!globalConfig) return true;

  const providerConfig = globalConfig[provider];
  if (!providerConfig) return true; // not in config = allowed

  // The admin's provider toggle. It used to be ignored, so switching a
  // provider off left its models selectable.
  if (providerConfig.enabled === false) return false;

  // If explicit model list, check membership
  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models.includes(modelId);
  }

  // Empty list means all disabled
  if (providerConfig.models && providerConfig.models.length === 0) {
    return false;
  }

  return true; // no model list set = all allowed
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
 * A model definition for an id returned by a provider's `/models` endpoint.
 *
 * Pi's `registerProvider` **replaces** a provider's model list — the extension's
 * `models` are composed over the catalog, not merged into it
 * (`applyExtension` in the SDK's `provider-composer.js`), and a definition only
 * inherits `api`/`baseUrl` from the catalog entry it shadows. Everything else
 * must be stated here, so a definition built from "id + name" alone downgrades
 * a model Pi knows well: `reasoning: false` makes thinking impossible,
 * `input: ["text", "image"]` makes a text-only endpoint answer 400, and
 * zero cost plus Pi's default limits hide the real context window.
 *
 * A catalog hit is therefore used verbatim; only genuinely unknown ids (a model
 * newer than the installed Pi catalog) fall back to conservative values.
 */
function defineDiscoveredModel(
  runtime: ModelRuntime,
  provider: string,
  id: string,
  limits: ProviderModelLimits,
): ProviderModelDefinition {
  const known = runtime.getModel(provider, id);

  if (known) {
    return {
      id,
      name: known.name || id,
      api: known.api,
      reasoning: known.reasoning,
      input: known.input,
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
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limitFields(limits),
  };
}

/**
 * Register a provider from its `/models` listing.
 *
 * Shared by the tenant runtime and the admin model browser so both see the same
 * models: the admin route used to duplicate this (with its own base URLs and
 * hardcoded limits), so a fix here would silently miss the admin page.
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
  },
): Promise<string[]> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const modelIds = await fetchOpenAIModels(baseUrl, options.apiKey);

  runtime.registerProvider(options.provider, {
    baseUrl,
    apiKey: options.apiKey || "placeholder",
    api: "openai-completions",
    ...(modelIds.length > 0
      ? {
          models: modelIds.map((m) =>
            defineDiscoveredModel(runtime, options.provider, m, options.limits),
          ),
        }
      : {}),
  });

  return modelIds;
}

/**
 * Build a ModelRuntime for a user, with discovered models.
 * Merges global (admin) + user-scoped providers (user keys take priority).
 * Returns the runtime and a flat list of models for UI select options.
 * Models are filtered by global admin config (if any).
 */
export async function buildModelRuntime(userId: string) {
  const globalConfig = await getGlobalModelConfig();

  const keySelect = {
    provider: true,
    encryptedKey: true,
    baseUrl: true,
    contextWindow: true,
    maxOutputTokens: true,
  };

  // Fetch global providers (userId = null)
  const globalKeys = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: keySelect,
  });

  // Fetch user-scoped providers (user keys override global ones)
  const userKeys = await prisma.providerApiKey.findMany({
    where: { userId },
    select: keySelect,
  });

  // Merge: global keys as base, user keys override by provider
  const mergedMap = new Map<
    string,
    { provider: string; encryptedKey: string; baseUrl: string | null } & ProviderModelLimits
  >();
  for (const key of globalKeys) {
    mergedMap.set(key.provider, key);
  }
  for (const key of userKeys) {
    mergedMap.set(key.provider, key);
  }
  const storedKeys = Array.from(mergedMap.values());

  // Credentials come from the database only. `ModelRuntime.create()` would
  // otherwise read the host's ~/.pi/agent/auth.json, models.json and
  // models-store.json (SDK docs, "Credential priority"), handing every tenant
  // the operator's provider keys and private endpoints — and writing fetched
  // catalogs into the operator's Pi directory.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });

  // Set runtime API keys on the model runtime. The decrypted keys are kept for
  // the discovery pass below — the same provider key must not be decrypted (or
  // its failure logged) twice.
  const apiKeys = new Map<string, string>();
  for (const key of storedKeys) {
    try {
      const decryptedKey = decrypt(key.encryptedKey);
      if (decryptedKey) {
        apiKeys.set(key.provider, decryptedKey);
        await modelRuntime.setRuntimeApiKey(key.provider, decryptedKey);
      }
    } catch (err) {
      console.error(`Failed to decrypt the API key for provider ${key.provider}:`, err);
    }
  }

  // Track discovered models for the flat list
  const discoveredModels: Array<{ provider: string; id: string; name: string }> = [];

  for (const key of storedKeys) {
    const limits: ProviderModelLimits = {
      contextWindow: key.contextWindow,
      maxOutputTokens: key.maxOutputTokens,
    };

    // Isolate per provider: a bad key, an unreachable endpoint or a rejected
    // model definition must not take down every other provider.
    try {
      const decryptedKey = apiKeys.get(key.provider);

      // A self-hosted OpenAI-compatible endpoint: discover from the URL the
      // user configured.
      const baseUrl =
        key.provider === "custom"
          ? key.baseUrl
          : DISCOVERABLE_PROVIDERS.has(key.provider)
            ? getProviderBaseUrl(key.provider)
            : null;

      if (baseUrl) {
        const modelIds = await registerDiscoveredModels(modelRuntime, {
          provider: key.provider,
          baseUrl,
          apiKey: decryptedKey,
          limits,
        });

        for (const m of modelIds) {
          discoveredModels.push({ provider: key.provider, id: m, name: m });
        }
      }
    } catch (err) {
      console.error(`Failed to register provider ${key.provider}:`, err);
    }
  }

  // Get available models from the runtime. `reasoning` and `contextWindow` come
  // along: the pickers badge thinking models with them, and dropping them here
  // meant the UI received a bare {id, name} list (the fields are optional in the
  // response type, so nothing failed — the badges just never appeared).
  const available = modelRuntime.getAvailableSnapshot();
  const allModels: AvailableModel[] = available.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
  }));

  // Add discovered custom models (not already in built-in list)
  const knownIds = new Set(allModels.map((m) => `${m.provider}:${m.id}`));
  for (const dm of discoveredModels) {
    if (!knownIds.has(`${dm.provider}:${dm.id}`)) {
      const model = modelRuntime.getModel(dm.provider, dm.id);
      allModels.push({
        ...dm,
        reasoning: model?.reasoning ?? false,
        contextWindow: model?.contextWindow,
      });
    }
  }

  // Apply global admin model filtering
  const filteredModels = allModels.filter((m) => isModelAllowed(globalConfig, m.provider, m.id));

  return { modelRuntime, models: filteredModels };
}
