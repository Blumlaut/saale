import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createSandboxOperations } from "@/lib/sandbox/operations";
import { resolveSandboxEnv } from "@/lib/sandbox/env";
import { userIdentity } from "@/lib/sandbox/identity";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { buildModelRuntime } from "./models";
import { resolveTools } from "./tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig, type ToolExposureConfig } from "./tool-categories";

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
 * Create workspace-backed Pi built-in tools.
 *
 * Commands run in the user's sandbox container, files are read and written
 * directly from the volume. The user's own environment variables are resolved
 * once, here: a pooled session is rebuilt when they change (the write path
 * evicts it), which is what keeps a value out of a long-lived object.
 */
export async function createSandboxScopedTools(
  userId: string,
  _sessionId: string,
): Promise<{
  read: ToolDefinition;
  write: ToolDefinition;
  edit: ToolDefinition;
  bash: ToolDefinition;
}> {
  const homeDir = userWorkspacePath(userId);

  const env = await resolveSandboxEnv(userId).catch((err) => {
    console.error("Failed to load sandbox environment variables:", err);
    return {};
  });

  const ops = createSandboxOperations({
    identity: userIdentity(userId),
    root: homeDir,
    env,
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
  /** Per-category exposure (`AppSettings.toolExposure`). */
  toolExposure?: ToolExposureConfig | null | undefined;
  modelProvider: string | undefined;
  modelName: string | undefined;
  /** Optional wrapper applied to every resolved tool (e.g. approval gate). */
  wrapTool?: (tool: ToolDefinition) => ToolDefinition;
}) {
  const { modelRuntime } = await buildModelRuntime(options.userId);

  const enabled = resolveToolConfig(options.toolConfig);

  // Caller-supplied tools get the same wrappers as the resolved ones: without
  // this they would execute outside the approval gate (and outside the abort
  // race), i.e. a tool added by a caller would silently be ungated.
  const allCustomTools: ToolDefinition[] = options.wrapTool
    ? options.customTools.map((tool) => options.wrapTool!(tool))
    : [...options.customTools];

  const resolvedTools = await resolveTools(options.userId, options.sessionId, enabled, {
    createSandboxScopedTools,
    ...(options.wrapTool ? { wrapWithApproval: options.wrapTool } : {}),
    ...(options.toolExposure ? { exposure: options.toolExposure } : {}),
  });
  allCustomTools.push(...resolvedTools);

  let model;
  if (options.modelProvider && options.modelName) {
    model = modelRuntime.getModel(options.modelProvider, options.modelName);
  }

  return { modelRuntime, allCustomTools, model };
}
