import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createTerminalOperations } from "@/lib/terminal/operations";
import { getTerminalHomeDir } from "@/lib/terminal/client";
import { getGitHubEnv } from "@/lib/github";
import { buildModelRuntime } from "./models";
import { resolveTools } from "./tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "./tool-categories";

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
    // `createBashTool` (the AgentTool form) rather than its ToolDefinition
    // variant: it drops Pi's TUI renderers, which a headless host never uses.
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
