import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * Fetch models from an OpenAI-compatible /v1/models endpoint.
 */
async function fetchOpenAIModels(baseUrl: string, apiKey?: string): Promise<Array<{ id: string; name: string }>> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    if (!data?.data?.length) return [];

    return data.data
      .map((m: any) => ({
        id: m.id,
        name: m.id, // Use ID as name since we don't have display names
      }))
      .slice(0, 200); // Cap at 200 models
  } catch {
    return [];
  }
}

/**
 * GET /api/providers/models — Returns available models based on user's configured providers.
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load user's provider API keys from DB
  const storedKeys = await prisma.providerApiKey.findMany({
    where: { userId: session.user.id },
    select: { provider: true, encryptedKey: true, baseUrl: true },
  });

  // Build in-memory auth storage with user's API keys
  const authStorage = AuthStorage.inMemory();

  for (const key of storedKeys) {
    try {
      const decryptedKey = decrypt(key.encryptedKey);
      if (decryptedKey) {
        authStorage.setRuntimeApiKey(key.provider, decryptedKey);
      }
    } catch {
      // Skip invalid keys
    }
  }

  // Create model registry
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  // Register custom OpenAI-compatible providers and discover their models
  for (const key of storedKeys) {
    if (key.provider === "custom" && key.baseUrl) {
      try {
        const decryptedKey = decrypt(key.encryptedKey);
        const baseUrl = key.baseUrl.replace(/\/+$/, "");

        // Fetch models from the server
        const discoveredModels = await fetchOpenAIModels(baseUrl, decryptedKey);

        if (discoveredModels.length > 0) {
          // Register with discovered models
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions" ,
            models: discoveredModels.map((m) => ({
              id: m.id,
              name: m.name,
              api: "openai-completions" ,
              reasoning: false,
              input: ["text"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            })),
          });
        } else {
          // No models discovered — still register so auth works
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions" ,
          });
        }
      } catch {
        console.warn(`[pi] Failed to register custom provider`);
      }
    }
  }

  // Get available models
  const available = modelRegistry.getAvailable();

  // Group by provider
  const byProvider: Record<string, Array<{
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number };
  }>> = {};

  for (const model of available) {
    if (!byProvider[model.provider]) {
      byProvider[model.provider] = [];
    }
    byProvider[model.provider].push({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
      },
    });
  }

  // Get provider display names
  const providers = Object.keys(byProvider).map((p) => ({
    id: p,
    name: modelRegistry.getProviderDisplayName(p),
    modelCount: byProvider[p].length,
  }));

  return NextResponse.json({
    providers,
    models: byProvider,
    totalModels: available.length,
  });
}
