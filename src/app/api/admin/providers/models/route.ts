import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { requireAdmin } from "../../settings/auth";
import { fetchOpenAIModels } from "@/lib/pi/models";

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
 * GET /api/admin/providers/models — List models available from global providers only.
 * Used by the admin models page to show/enable/disable models globally.
 */
export async function GET() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  // Fetch only global providers
  const globalKeys = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: { provider: true, encryptedKey: true, baseUrl: true },
  });

  // Credentials come from the database only. `ModelRuntime.create()` would
  // otherwise read the host's ~/.pi/agent/auth.json, models.json and
  // models-store.json (SDK docs, "Credential priority"), handing every tenant
  // the operator's provider keys and private endpoints — and writing fetched
  // catalogs into the operator's Pi directory.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });

  // Set runtime API keys
  for (const key of globalKeys) {
    try {
      const decryptedKey = decrypt(key.encryptedKey);
      if (decryptedKey) {
        await modelRuntime.setRuntimeApiKey(key.provider, decryptedKey);
      }
    } catch (err) {
      console.error(`Failed to decrypt key for provider ${key.provider}:`, err);
    }
  }

  const discoveredModels: Array<{ provider: string; id: string; name: string }> = [];

  for (const key of globalKeys) {
    if (key.provider === "custom" && key.baseUrl) {
      const decryptedKey = decrypt(key.encryptedKey);
      const baseUrl = key.baseUrl.replace(/\/+$/, "");

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

  // Merge: start with built-in available models, then add discovered custom models
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

  // Group by provider
  const models: Record<string, Array<{ id: string; name: string; reasoning: boolean }>> = {};
  const providerSet = new Set<string>();

  for (const m of allModels) {
    providerSet.add(m.provider);
    if (!models[m.provider]) {
      models[m.provider] = [];
    }
    const list = models[m.provider]!;
    list.push({
      id: m.id,
      name: m.name,
      reasoning: m.id.includes("r1") || m.id.includes("reason"),
    });
  }

  const providers = Array.from(providerSet).map((id) => ({
    id,
    name: modelRuntime.getProvider(id)?.name ?? id,
    modelCount: (models[id] ?? []).length,
  }));

  return NextResponse.json({ models, providers });
}
