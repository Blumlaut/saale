import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * A single model entry discovered from an OpenAI-compatible /models endpoint.
 */
interface DiscoveredModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Try to extract context window from a raw model object returned by /models.
 * Different providers use different field names.
 */
function extractContextWindow(model: Record<string, unknown>): number | undefined {
  // Standard OpenAI-compatible fields
  if (typeof model.max_model_length === "number") return model.max_model_length;
  if (typeof model.max_tokens === "number") return model.max_tokens;
  if (typeof model.max_input_tokens === "number") return model.max_input_tokens;
  if (typeof model.max_completion_tokens === "number") return model.max_completion_tokens;

  // Ollama / LMStudio style
  if (typeof model.context_length === "number") return model.context_length;

  // Some providers nest it under capabilities
  if (model.capabilities && typeof model.capabilities === "object") {
    const caps = model.capabilities as Record<string, unknown>;
    if (typeof caps.max_tokens === "number") return caps.max_tokens;
    if (typeof caps.context_length === "number") return caps.context_length;
  }

  return undefined;
}

/**
 * Try to extract max output tokens from a raw model object.
 */
function extractMaxTokens(model: Record<string, unknown>): number | undefined {
  if (typeof model.max_completion_tokens === "number") return model.max_completion_tokens;
  if (typeof model.max_output_tokens === "number") return model.max_output_tokens;
  return undefined;
}

/**
 * Fetch models from an OpenAI-compatible /models endpoint.
 */
async function fetchOpenAIModels(
  baseUrl: string,
  apiKey?: string,
): Promise<{ models: DiscoveredModel[]; error?: string }> {
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

    const models: DiscoveredModel[] = data.data
      .map((m: Record<string, unknown>) => ({
        id: String(m.id),
        contextWindow: extractContextWindow(m),
        maxTokens: extractMaxTokens(m),
      }))
      .slice(0, 200);

    return { models };
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

      console.log(
        `[providers] Registering custom provider: baseUrl=${baseUrl}, hasKey=${!!decryptedKey}`,
      );

      // Fetch models from the server
      const { models: discoveredModels, error: modelError } = await fetchOpenAIModels(
        baseUrl,
        decryptedKey,
      );

      if (modelError) {
        console.warn(`[providers] Model discovery failed: ${modelError}`);
      }

      try {
        if (discoveredModels.length > 0) {
          console.log(`[providers] Registering ${discoveredModels.length} discovered models`);
          // Pi SDK requires apiKey when defining models — use a placeholder for local servers
          const apiKey = decryptedKey || "placeholder";
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey,
            api: "openai-completions",
            models: discoveredModels.map((m) => ({
              id: m.id,
              name: m.id,
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
              ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
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
  const byProvider: Record<
    string,
    Array<{
      id: string;
      name: string;
      reasoning: boolean;
      contextWindow?: number;
      maxTokens?: number;
      cost: { input: number; output: number };
    }>
  > = {};

  for (const model of available) {
    const provider = model.provider;
    if (!byProvider[provider]) {
      byProvider[provider] = [];
    }
    // Guard above ensures this is defined
    const providerModels = byProvider[provider]!;
    providerModels.push({
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
    // Object.keys only returns keys that exist
    modelCount: (byProvider[p] ?? []).length,
  }));

  return NextResponse.json({
    providers,
    models: byProvider,
    totalModels: available.length,
  });
}
