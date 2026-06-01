import {
  createAgentSession,
  type CreateAgentSessionResult,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildModelRegistry } from "./models";
import { createFileTool } from "./tools/file-tools";
import { createChatSearchTool } from "./tools/chat-tools";

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
  // Build model registry with user's providers and discovered models
  const { modelRegistry, authStorage } = await buildModelRegistry(options.userId);

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
