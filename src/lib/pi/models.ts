import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

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

    if (!res.ok) return [];

    const data = await res.json();
    if (!data?.data?.length) return [];

    return data.data.map((m: { id: string }) => String(m.id)).slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * Build a fully-populated ModelRegistry for a user, with discovered models.
 * Merges global (admin) + user-scoped providers (user keys take priority).
 * Returns the registry, auth storage, and a flat list of models for UI select options.
 * Models are filtered by global admin config (if any).
 */
export async function buildModelRegistry(userId: string) {
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

  const authStorage = AuthStorage.inMemory();
  for (const key of storedKeys) {
    try {
      const decryptedKey = decrypt(key.encryptedKey);
      if (decryptedKey) {
        authStorage.setRuntimeApiKey(key.provider, decryptedKey);
      }
    } catch {
      // skip
    }
  }

  const modelRegistry = ModelRegistry.inMemory(authStorage);

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
          modelRegistry.registerProvider("custom", {
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
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions",
          });
        }
      } catch {
        // skip
      }
    }
  }

  // Use discovered models if we have them, otherwise fall back to registry defaults
  const available = modelRegistry.getAvailable();
  const allModels =
    discoveredModels.length > 0
      ? discoveredModels
      : available.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
        }));

  // Apply global admin model filtering
  const filteredModels = allModels.filter((m) => isModelAllowed(globalConfig, m.provider, m.id));

  return { modelRegistry, authStorage, models: filteredModels };
}
