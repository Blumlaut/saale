import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * Fetch models from an OpenAI-compatible /models endpoint.
 */
async function fetchOpenAIModels(baseUrl: string, apiKey?: string): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    console.log(`[providers] Fetching models from ${url}`);
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });

    console.log(`[providers] Response status: ${res.status}`);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`[providers] Error response: ${body.slice(0, 200)}`);
      return {
        models: [],
        error: `HTTP ${res.status} from ${url}${body ? `: ${body.slice(0, 100)}` : ""}`,
      };
    }

    const data = await res.json();
    console.log(`[providers] Got ${data.data?.length ?? 0} models from ${url}`);

    if (!data?.data?.length) {
      return {
        models: [],
        error: "No models returned by server",
      };
    }

    return {
      models: data.data
        .map((m: any) => m.id)
        .slice(0, 200),
    };
  } catch (err) {
    console.error(`[providers] Fetch failed:`, err);
    return {
      models: [],
      error: `${(err as Error).message} (checking ${url})`,
    };
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
        console.log(`[providers] Set API key for provider: ${key.provider}`);
      }
    } catch (err) {
      console.warn(`[providers] Failed to decrypt API key for ${key.provider}:`, err);
    }
  }

  // Create model registry
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  // Register custom OpenAI-compatible providers and discover their models
  for (const key of storedKeys) {
    if (key.provider === "custom" && key.baseUrl) {
      const decryptedKey = decrypt(key.encryptedKey);
      const baseUrl = key.baseUrl.replace(/\/+$/, "");

      console.log(`[providers] Registering custom provider: baseUrl=${baseUrl}, hasKey=${!!decryptedKey}`);

      // Fetch models from the server
      const { models: discoveredModels, error: modelError } = await fetchOpenAIModels(baseUrl, decryptedKey);

      if (modelError) {
        console.warn(`[providers] Model discovery failed: ${modelError}`);
      }

      try {
        if (discoveredModels.length > 0) {
          console.log(`[providers] Registering ${discoveredModels.length} discovered models`);
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions",
            models: discoveredModels.map((m) => ({
              id: m,
              name: m,
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            })),
          });
        } else {
          console.log(`[providers] No models discovered, registering provider without models`);
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions",
          });
        }
        console.log(`[providers] Custom provider registered successfully`);
      } catch (err) {
        console.error(`[providers] Failed to register custom provider:`, err);
      }
    }
  }

  // Get available models
  const available = modelRegistry.getAvailable();
  console.log(`[providers] Total available models: ${available.length}`);

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
