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
 * Create an isolated Pi agent session for a user.
 * Each user gets their own in-memory session with custom tools scoped to their data.
 *
 * Loads provider API keys from the database, decrypts them, and configures
 * them on an in-memory AuthStorage so the Pi SDK can resolve them.
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
    select: { provider: true, encryptedKey: true },
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
      // Skip invalid keys — they'll just be unavailable
      console.warn(`[pi] Failed to decrypt API key for provider ${key.provider}`);
    }
  }

  // Create model registry with user's auth storage
  const modelRegistry = ModelRegistry.inMemory(authStorage);

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
    model: model ?? undefined,
    customTools: allCustomTools,
    thinkingLevel: (options.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ?? "off",
  });

  return result;
}
