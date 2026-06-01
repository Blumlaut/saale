import {
  createAgentSession,
  type CreateAgentSessionResult,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildModelRegistry } from "./models";
import { createFileTool } from "./tools/file-tools";
import { createChatSearchTool } from "./tools/chat-tools";
import { createMailTools } from "./tools/mail-tools";
import { createJobTools } from "./tools/job-tools";

/**
 * Configuration for which tool categories are enabled.
 */
export interface ToolConfig {
  files?: boolean;
  email?: boolean;
  jobs?: boolean;
  chatSearch?: boolean;
}

const DEFAULT_TOOL_CONFIG: Required<ToolConfig> = {
  files: true,
  email: true,
  jobs: true,
  chatSearch: true,
};

/**
 * Merge user tool config with defaults.
 */
function resolveToolConfig(config: ToolConfig | null | undefined): Required<ToolConfig> {
  if (!config) return DEFAULT_TOOL_CONFIG;
  return { ...DEFAULT_TOOL_CONFIG, ...config };
}

/**
 * Create an isolated Pi agent session for a user.
 */
export async function createPiSession(options: {
  userId: string;
  customTools: ToolDefinition[];
  toolConfig?: ToolConfig;
  modelProvider?: string;
  modelName?: string;
  thinkingLevel?: string;
}): Promise<CreateAgentSessionResult> {
  // Build model registry with user's providers and discovered models
  const { modelRegistry, authStorage } = await buildModelRegistry(options.userId);

  // Resolve tool config (which tool categories are enabled)
  const enabled = resolveToolConfig(options.toolConfig);

  // Build user-scoped custom tools (only if enabled)
  const allCustomTools: ToolDefinition[] = [...options.customTools];

  if (enabled.files) {
    const fileTools = createFileTool(options.userId);
    allCustomTools.push(
      fileTools.fileRead,
      fileTools.fileWrite,
      fileTools.fileList,
      fileTools.fileDelete,
    );
  }

  if (enabled.chatSearch) {
    allCustomTools.push(createChatSearchTool(options.userId));
  }

  if (enabled.email) {
    const mailTools = createMailTools(options.userId);
    allCustomTools.push(
      mailTools.mailAccountsTool,
      mailTools.mailFoldersTool,
      mailTools.mailSyncTool,
      mailTools.mailListTool,
      mailTools.mailReadTool,
      mailTools.mailSearchTool,
      mailTools.mailSendTool,
      mailTools.mailTagTool,
      mailTools.mailMoveTool,
      mailTools.mailDeleteTool,
    );
  }

  if (enabled.jobs) {
    const jobTools = createJobTools(options.userId);
    allCustomTools.push(
      jobTools.jobListTool,
      jobTools.jobEnableTool,
      jobTools.jobRunTool,
      jobTools.jobLogsTool,
    );
  }

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
