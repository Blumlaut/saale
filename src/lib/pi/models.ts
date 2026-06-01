import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * Fetch model IDs from an OpenAI-compatible /models endpoint.
 */
export async function fetchOpenAIModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
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

    return data.data
      .map((m: { id: string }) => String(m.id))
      .slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * Build a fully-populated ModelRegistry for a user, with discovered models.
 * Returns the registry, auth storage, and a flat list of models for UI select options.
 */
export async function buildModelRegistry(userId: string) {
  const storedKeys = await prisma.providerApiKey.findMany({
    where: { userId },
    select: { provider: true, encryptedKey: true, baseUrl: true },
  });

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
              input: ["text"] as const,
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
  const allModels = discoveredModels.length > 0
    ? discoveredModels
    : available.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
      }));

  return { modelRegistry, authStorage, models: allModels };
}
