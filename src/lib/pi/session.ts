import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  SessionManager,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createTerminalOperations } from "@/lib/terminal/operations";
import { getTerminalHomeDir } from "@/lib/terminal/client";
import { getGitHubEnv } from "@/lib/github";
import { buildModelRuntime } from "./models";
import { resolveTools } from "./tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "./tool-categories";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

// Re-export for consumers
export type { ToolConfig };

/**
 * Merge user tool config with defaults.
 */
function resolveToolConfig(config: ToolConfig | null | undefined): Required<ToolConfig> {
  if (!config) return DEFAULT_TOOL_CONFIG;
  return { ...DEFAULT_TOOL_CONFIG, ...config };
}

/**
 * Get the isolated workspace directory for a user.
 */
function getUserDir(userId: string): string {
  return path.join(UPLOADS_DIR, userId);
}

/**
 * Create terminal-backed Pi built-in tools (sandboxed via open-terminal).
 * Used when bash is enabled — all file ops go through the container.
 * Injects GH_TOKEN into every command when GitHub integration is enabled.
 */
export async function createTerminalScopedTools(
  userId: string,
  sessionId: string,
): Promise<{
  read: ToolDefinition;
  write: ToolDefinition;
  edit: ToolDefinition;
  bash: ToolDefinition;
}> {
  const homeDir = getTerminalHomeDir(userId);

  // Inject GH_TOKEN if GitHub integration is enabled for this user
  const githubEnv = await getGitHubEnv(userId).catch((err) => {
    console.error("Failed to load GitHub env for terminal:", err);
    return null;
  });

  const ops = createTerminalOperations({
    userId,
    sessionId,
    cwd: homeDir,
    extraEnv: githubEnv ?? undefined,
  });

  return {
    read: createReadTool(homeDir, { operations: ops.read }),
    write: createWriteTool(homeDir, { operations: ops.write }),
    edit: createEditTool(homeDir, { operations: ops.edit }),
    bash: createBashTool(homeDir, { operations: ops.bash }),
  };
}

/**
 * Build the model runtime and resolve tools for a user.
 * Shared between createPiSession and createPersistentSession.
 */
export async function buildSessionDeps(options: {
  userId: string;
  sessionId: string;
  customTools: ToolDefinition[];
  toolConfig: ToolConfig | null | undefined;
  modelProvider: string | undefined;
  modelName: string | undefined;
  /** Optional wrapper applied to every resolved tool (e.g. approval gate). */
  wrapTool?: (tool: ToolDefinition) => ToolDefinition;
}) {
  const { modelRuntime } = await buildModelRuntime(options.userId);

  const enabled = resolveToolConfig(options.toolConfig);
  const allCustomTools: ToolDefinition[] = [...options.customTools];

  const resolvedTools = await resolveTools(options.userId, options.sessionId, enabled, {
    createTerminalScopedTools,
    ...(options.wrapTool ? { wrapWithApproval: options.wrapTool } : {}),
  });
  allCustomTools.push(...resolvedTools);

  let model;
  if (options.modelProvider && options.modelName) {
    model = modelRuntime.getModel(options.modelProvider, options.modelName);
  }

  return { modelRuntime, allCustomTools, model };
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
  // Ensure the user's workspace directory exists
  const userDir = getUserDir(options.userId);
  await fs.mkdir(userDir, { recursive: true });

  // Generate a session ID for open-terminal cwd persistence
  const sessionId = crypto.randomUUID();

  // Build shared dependencies (model runtime, tools, model resolution)
  const { modelRuntime, allCustomTools, model } = await buildSessionDeps({
    userId: options.userId,
    sessionId,
    customTools: options.customTools,
    toolConfig: options.toolConfig,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
  });

  const result = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    noTools: "builtin",
    ...(model ? { model } : {}),
    customTools: allCustomTools,
    thinkingLevel:
      (options.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") ??
      "off",
  });

  return result;
}
