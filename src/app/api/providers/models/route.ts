import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * GET /api/providers/models — Returns available models based on user's configured providers.
 *
 * Loads the user's API keys, creates an in-memory ModelRegistry, registers any
 * custom OpenAI-compatible providers, and returns all models that have auth configured.
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

  // Register custom OpenAI-compatible providers
  for (const key of storedKeys) {
    if (key.provider === "custom" && key.baseUrl) {
      try {
        const decryptedKey = decrypt(key.encryptedKey);
        modelRegistry.registerProvider("custom", {
          baseUrl: key.baseUrl.replace(/\/+$/, ""), // trim trailing slashes
          apiKey: decryptedKey,
          api: "openai-completions",
        });
      } catch {
        // Skip invalid keys
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
