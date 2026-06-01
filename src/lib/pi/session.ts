import {
  createAgentSession,
  type CreateAgentSessionResult,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { createFileTool } from "./tools/file-tools";
import { createChatSearchTool } from "./tools/chat-tools";

/**
 * Fetch models from an OpenAI-compatible /models endpoint.
 */
async function fetchOpenAIModels(
  baseUrl: string,
  apiKey?: string,
): Promise<Array<{ id: string; name: string }>> {
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
      .map((m: { id: string }) => ({
        id: m.id,
        name: m.id,
      }))
      .slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * Create an isolated Pi agent session for a user.
 */
export async function createPiSession(options: {
  userId: string;
  customTools: ToolDefinition[];
  modelProvider?: string;
  modelName?: string;
  thinkingLevel?: string;
}): Promise<CreateAgentSessionResult> {
  // Load user's provider API keys from DB
  const storedKeys = await prisma.providerApiKey.findMany({
    where: { userId: options.userId },
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
      console.warn(`[pi] Failed to decrypt API key for provider ${key.provider}`);
    }
  }

  // Create model registry with user's auth storage
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
          // Pi SDK requires apiKey when defining models — use a placeholder for local servers
          const apiKey = decryptedKey || "placeholder";
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey,
            api: "openai-completions",
            models: discoveredModels.map((m) => ({
              id: m.id,
              name: m.name,
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            })),
          });
        } else {
          modelRegistry.registerProvider("custom", {
            baseUrl,
            apiKey: decryptedKey,
            api: "openai-completions",
          });
        }
      } catch (err) {
        console.error(`[pi] Failed to register custom provider:`, err);
      }
    }
  }

  // Build user-scoped custom tools
  const fileTools = createFileTool(options.userId);
  const chatSearchTool = createChatSearchTool(options.userId);

  const allCustomTools: ToolDefinition[] = [
    ...options.customTools,
    fileTools.fileRead,
    fileTools.fileWrite,
    fileTools.fileList,
    fileTools.fileDelete,
    chatSearchTool,
  ];

  // Resolve the model if specified
  let model;
  if (options.modelProvider && options.modelName) {
    model = modelRegistry.find(options.modelProvider, options.modelName);
  }

  const result = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    ...(model ? { model } : {}),
    customTools: allCustomTools,
    thinkingLevel:
      (options.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ?? "off",
  });

  return result;
}
