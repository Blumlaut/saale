import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

interface ProviderModelConfig {
  enabled: boolean;
  models?: string[];
}

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

// Providers that support OpenAI-compatible /models endpoint for dynamic discovery
const DISCOVERABLE_PROVIDERS = new Set(["openrouter", "together", "fireworks", "huggingface"]);

/**
 * Get the base URL for a known provider's OpenAI-compatible API.
 */
function getProviderBaseUrl(provider: string): string | null {
  const baseUrls: Record<string, string> = {
    openrouter: "https://openrouter.ai/api/v1",
    together: "https://api.together.xyz",
    fireworks: "https://api.fireworks.ai/inference/v1",
    huggingface: "https://api-inference.huggingface.com",
  };
  return baseUrls[provider] ?? null;
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
 * Build a ModelRuntime for a user, with discovered models.
 * Merges global (admin) + user-scoped providers (user keys take priority).
 * Returns the runtime and a flat list of models for UI select options.
 * Models are filtered by global admin config (if any).
 */
export async function buildModelRuntime(userId: string) {
  const globalConfig = await getGlobalModelConfig();

  // Fetch global providers (userId = null)
  const globalKeys = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: { provider: true, encryptedKey: true, baseUrl: true },
  });

  // Fetch user-scoped providers (user keys override global ones)
  const userKeys = await prisma.providerApiKey.findMany({
    where: { userId },
    select: { provider: true, encryptedKey: true, baseUrl: true },
  });

  // Merge: global keys as base, user keys override by provider
  const mergedMap = new Map<
    string,
    { provider: string; encryptedKey: string; baseUrl: string | null }
  >();
  for (const key of globalKeys) {
    mergedMap.set(key.provider, key);
  }
  for (const key of userKeys) {
    mergedMap.set(key.provider, key);
  }
  const storedKeys = Array.from(mergedMap.values());

  // Create ModelRuntime (uses in-memory credential store by default)
  const modelRuntime = await ModelRuntime.create();

  // Set runtime API keys on the model runtime
  for (const key of storedKeys) {
    try {
      const decryptedKey = decrypt(key.encryptedKey);
      if (decryptedKey) {
        await modelRuntime.setRuntimeApiKey(key.provider, decryptedKey);
      }
    } catch {
      // skip
    }
  }

  // Track discovered models for the flat list
  const discoveredModels: Array<{ provider: string; id: string; name: string }> = [];

  for (const key of storedKeys) {
    if (key.provider === "custom" && key.baseUrl) {
      const decryptedKey = decrypt(key.encryptedKey);
      const baseUrl = key.baseUrl.replace(/\/+$/, "");

      // Fetch models from the server
      const modelIds = await fetchOpenAIModels(baseUrl, decryptedKey);

      try {
        if (modelIds.length > 0) {
          const apiKey = decryptedKey || "placeholder";
          modelRuntime.registerProvider("custom", {
            baseUrl,
            apiKey,
            api: "openai-completions",
            models: modelIds.map((m) => ({
              id: m,
              name: m,
              api: "openai-completions" as const,
              reasoning: false,
              input: ["text", "image"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            })),
          });

          for (const m of modelIds) {
            discoveredModels.push({ provider: "custom", id: m, name: m });
          }
        } else {
          modelRuntime.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions",
          });
        }
      } catch (err) {
        console.error(`Failed to register custom provider ${key.baseUrl}:`, err);
      }
    }

    // Dynamic model discovery for providers supporting OpenAI-compatible /models endpoint
    if (DISCOVERABLE_PROVIDERS.has(key.provider) && key.provider !== "custom") {
      const decryptedKey = decrypt(key.encryptedKey);
      const providerBaseUrl = getProviderBaseUrl(key.provider);
      if (providerBaseUrl) {
        const modelIds = await fetchOpenAIModels(providerBaseUrl, decryptedKey);
        if (modelIds.length > 0) {
          // Register discovered models to override built-in list
          modelRuntime.registerProvider(key.provider, {
            baseUrl: providerBaseUrl,
            apiKey: decryptedKey || "placeholder",
            api: "openai-completions",
            models: modelIds.map((m) => ({
              id: m,
              name: m,
              api: "openai-completions" as const,
              reasoning: false,
              input: ["text", "image"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            })),
          });
        }
      }
    }
  }

  // Get available models from the runtime
  const available = modelRuntime.getAvailableSnapshot();
  const allModels = available.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
  }));

  // Add discovered custom models (not already in built-in list)
  const knownIds = new Set(allModels.map((m) => `${m.provider}:${m.id}`));
  for (const dm of discoveredModels) {
    if (!knownIds.has(`${dm.provider}:${dm.id}`)) {
      allModels.push(dm);
    }
  }

  // Apply global admin model filtering
  const filteredModels = allModels.filter((m) => isModelAllowed(globalConfig, m.provider, m.id));

  return { modelRuntime, models: filteredModels };
}
